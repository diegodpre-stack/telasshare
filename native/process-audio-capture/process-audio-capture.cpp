#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>
#include <atomic>
#include <cstdio>

using Microsoft::WRL::ComPtr;

static std::atomic<bool> running = true;

BOOL WINAPI OnConsoleSignal(DWORD) {
    running = false;
    return TRUE;
}

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    ActivationHandler() : event_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}
    ~ActivationHandler() { if (event_) CloseHandle(event_); }

    STDMETHODIMP QueryInterface(REFIID iid, void** value) override {
        if (!value) return E_POINTER;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *value = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        if (iid == __uuidof(IAgileObject)) {
            *value = static_cast<IAgileObject*>(this);
            AddRef();
            return S_OK;
        }
        *value = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override { return InterlockedIncrement(&refs_); }
    STDMETHODIMP_(ULONG) Release() override {
        const ULONG refs = InterlockedDecrement(&refs_);
        if (!refs) delete this;
        return refs;
    }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> unknown;
        HRESULT activationResult = E_FAIL;
        result_ = operation->GetActivateResult(&activationResult, &unknown);
        if (SUCCEEDED(result_)) result_ = activationResult;
        if (SUCCEEDED(result_)) result_ = unknown.As(&client_);
        SetEvent(event_);
        return S_OK;
    }

    HANDLE event() const { return event_; }
    HRESULT result() const { return result_; }
    ComPtr<IAudioClient> client() const { return client_; }

private:
    volatile LONG refs_ = 1;
    HANDLE event_ = nullptr;
    HRESULT result_ = E_PENDING;
    ComPtr<IAudioClient> client_;
};

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    const UINT64 rawWindow = _wcstoui64(argv[1], nullptr, 0);
    const HWND window = reinterpret_cast<HWND>(rawWindow);
    DWORD processId = 0;
    GetWindowThreadProcessId(window, &processId);
    if (!processId) return 3;

    _setmode(_fileno(stdout), _O_BINARY);
    SetConsoleCtrlHandler(OnConsoleSignal, TRUE);
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 4;

    AUDIOCLIENT_ACTIVATION_PARAMS activation = {};
    activation.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    activation.ProcessLoopbackParams.TargetProcessId = processId;
    activation.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT parameters = {};
    parameters.vt = VT_BLOB;
    parameters.blob.cbSize = sizeof(activation);
    parameters.blob.pBlobData = reinterpret_cast<BYTE*>(&activation);

    ActivationHandler* handler = new ActivationHandler();
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &parameters, handler, &operation);
    if (FAILED(hr)) { handler->Release(); CoUninitialize(); return 5; }
    WaitForSingleObject(handler->event(), 10000);
    hr = handler->result();
    ComPtr<IAudioClient> client = handler->client();
    handler->Release();
    if (FAILED(hr) || !client) { CoUninitialize(); return 6; }

    WAVEFORMATEX format = {};
    format.wFormatTag = WAVE_FORMAT_PCM;
    format.nChannels = 2;
    format.nSamplesPerSec = 48000;
    format.wBitsPerSample = 16;
    format.nBlockAlign = format.nChannels * format.wBitsPerSample / 8;
    format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
    hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &format, nullptr);
    if (FAILED(hr)) { CoUninitialize(); return 7; }

    HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!sampleEvent) { CoUninitialize(); return 8; }
    client->SetEventHandle(sampleEvent);
    ComPtr<IAudioCaptureClient> capture;
    hr = client->GetService(IID_PPV_ARGS(&capture));
    if (FAILED(hr)) { CloseHandle(sampleEvent); CoUninitialize(); return 9; }
    hr = client->Start();
    if (FAILED(hr)) { CloseHandle(sampleEvent); CoUninitialize(); return 10; }

    HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    while (running) {
        if (WaitForSingleObject(sampleEvent, 1000) != WAIT_OBJECT_0) continue;
        UINT32 frames = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&frames)) && frames) {
            BYTE* data = nullptr;
            DWORD flags = 0;
            UINT64 devicePosition = 0, qpcPosition = 0;
            if (FAILED(capture->GetBuffer(&data, &frames, &flags, &devicePosition, &qpcPosition))) { running = false; break; }
            const DWORD byteCount = frames * format.nBlockAlign;
            DWORD written = 0;
            bool ok = true;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                BYTE zeros[4096] = {};
                DWORD remaining = byteCount;
                while (remaining && ok) {
                    const DWORD amount = remaining > sizeof(zeros) ? sizeof(zeros) : remaining;
                    ok = WriteFile(output, zeros, amount, &written, nullptr) && written == amount;
                    remaining -= amount;
                }
            } else {
                ok = WriteFile(output, data, byteCount, &written, nullptr) && written == byteCount;
            }
            capture->ReleaseBuffer(frames);
            if (!ok) { running = false; break; }
        }
    }

    client->Stop();
    CloseHandle(sampleEvent);
    CoUninitialize();
    return 0;
}
