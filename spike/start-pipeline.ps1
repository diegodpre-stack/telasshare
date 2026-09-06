# Phase 1 pipeline: monitor -> GPU texture -> hardware H.264 -> WebRTC, with nothing touching the CPU
# in between. Run spike/whip-relay.mjs and open http://127.0.0.1:8099/ first; this connects to it.
#
# The capture stays in D3D11 memory all the way into the encoder -- that is the whole point of the
# exercise, and `gst-launch-1.0 -v` prints the negotiated memory type if you want to see it for yourself.
param(
  [string]$Endpoint = "http://127.0.0.1:8137/whip",
  [int]$MonitorIndex = 0,
  [int]$Fps = 60,
  # Kept in sync with what the OBS test used, so the two measurements stay comparable.
  [int]$BitrateKbps = 12000
)

$bin = "$env:LOCALAPPDATA\Programs\gstreamer\1.0\msvc_x86_64\bin"
if (-not (Test-Path "$bin\gst-launch-1.0.exe")) {
  Write-Error "GStreamer nao encontrado em $bin. Instale com: winget install --id gstreamerproject.gstreamer"
  exit 1
}
$env:PATH = "$bin;$env:PATH"
# webrtcsink logs which encoder it picked; without this the most important line of the run is invisible.
if (-not $env:GST_DEBUG) { $env:GST_DEBUG = "webrtcsink:4,whip*:4" }

Write-Host "pipeline -> $Endpoint  (monitor $MonitorIndex, ${Fps}fps, ${BitrateKbps}kbps)" -ForegroundColor Cyan

# whipsink, not whipclientsink. The latter wraps webrtcsink, which insists on encoding the stream itself:
# its codec-discovery pipeline fails outright on D3D11 memory, and feeding it already-encoded H.264 dies
# with "streaming stopped, reason not-negotiated" once a viewer attaches. whipsink takes RTP straight in,
# so the encoder stays ours and the frame stays on the GPU. What is lost with it is webrtcsink's
# congestion control -- which could not have driven amfh264enc anyway ("Bitrate handling is not supported
# yet for amfh264enc"), so the bitrate is fixed until that gap is closed.
#
# cabac and B-frames are off because Chrome only receives constrained baseline. AMF still stamps the SPS
# as plain baseline (420432), which Chrome rejects with an m-line of port 0 -- the relay rewrites
# profile-level-id on the way out to work around it.
& "$bin\gst-launch-1.0.exe" -e `
  d3d11screencapturesrc monitor-index=$MonitorIndex show-cursor=true `
  ! "video/x-raw(memory:D3D11Memory),framerate=$Fps/1" `
  ! d3d11convert `
  ! amfh264enc bitrate=$BitrateKbps cabac=false b-frames=0 `
  ! "video/x-h264,profile=constrained-baseline" `
  ! h264parse config-interval=-1 `
  ! rtph264pay aggregate-mode=zero-latency config-interval=-1 pt=96 `
  ! "application/x-rtp,media=video,encoding-name=H264,payload=96,clock-rate=90000" `
  ! whipsink whip-endpoint=$Endpoint
