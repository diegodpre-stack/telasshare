// Builds a portable app aimed at a server that is not the published one.
//
// This exists so a new server can be tried with the real app -- native capture included, which is the
// one thing a browser cannot test -- without publishing anything. Nothing here touches the release
// channel: `--publish never` is passed explicitly, and the identity of the build is changed so the
// result cannot be confused with, or interfere with, the TelasShare somebody already has installed.
//
// Run it as: npm run desktop:test -- https://telasshare.duckdns.org
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'

const given = process.argv[2] || process.env.TELASSHARE_SERVER
if (!given) {
  console.error('Informe o endereço do servidor de teste.\n')
  console.error('  npm run desktop:test -- https://telasshare.duckdns.org\n')
  process.exit(1)
}

let server
try { server = new URL(given) } catch {
  console.error(`Endereço inválido: ${given}`)
  process.exit(1)
}
// Not a preference. getUserMedia and getDisplayMedia are refused outside a secure origin, so a build
// aimed at plain http would come up with no microphone and no screen capture and no explanation.
if (server.protocol !== 'https:') {
  console.error('O endereço precisa ser https: sem origem segura o navegador recusa microfone e captura de tela.')
  process.exit(1)
}

// Native capture is most of the reason to build this rather than open a browser tab, so say plainly
// when it would be missing instead of shipping an app that quietly cannot do it.
if (!existsSync('native/gstreamer/bin/gst-launch-1.0.exe')) {
  console.error('native/gstreamer está vazio — o app sairia sem captura nativa, que é justamente o que este build existe para testar.')
  console.error('Rode o empacotamento do GStreamer antes, ou aceite testar só a captura do navegador.')
  process.exit(1)
}

console.log(`Servidor: ${server.origin}`)
console.log('Identidade separada do app instalado, e nada será publicado.\n')

// electron-builder applies `extraMetadata` by writing it into the package.json of the directory it is
// packaging -- which here is the project itself -- and does not always put the file back. It ate the
// scripts, the devDependencies and the build configuration once already, and the damage is silent until
// the next `npm run` fails. So the file is copied aside first and restored no matter how this ends.
const BACKUP = 'package.json.antes-do-teste'
copyFileSync('package.json', BACKUP)
const restore = () => { try { copyFileSync(BACKUP, 'package.json') } catch { /* nothing better to do */ } }
process.on('exit', restore)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { restore(); process.exit(1) })

// Node itself, running electron-builder's entry point directly. Not `npx` through a shell: with
// shell: true the arguments are concatenated rather than escaped, and one of them is an address typed
// on the command line -- which is exactly the shape of thing that should never reach a shell.
const result = spawnSync(process.execPath, [
  'node_modules/electron-builder/cli.js', '--win', 'portable',
  // The one flag that matters most here: no release, no tag, nothing pushed anywhere.
  '--publish', 'never',
  `--config.extraMetadata.telasshareServer=${server.origin}`,
  // A different name is a different userData folder, so this build cannot disturb the settings, rooms
  // or remembered layout of the app already installed.
  '--config.extraMetadata.name=telasshare-teste',
  '--config.extraMetadata.productName=TelasShare-Teste',
  '--config.appId=com.entretelas.teste',
  '--config.productName=TelasShare-Teste',
  '--config.portable.artifactName=TelasShare-Teste.exe',
], { stdio: 'inherit' })

restore()
if (result.status !== 0) process.exit(result.status ?? 1)
console.log('\nPronto: release/TelasShare-Teste.exe')
console.log('A janela dele diz TESTE no título, para não se confundir com o app de verdade.')
