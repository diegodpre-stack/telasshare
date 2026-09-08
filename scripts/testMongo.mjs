// A real MongoDB for the tests to run against, started and thrown away by them.
//
// Not a stand-in: mongodb-memory-server runs the actual server, so what the tests exercise is the real
// driver against real behaviour rather than a hand-written imitation that agrees with whatever the code
// happens to do. The alternative -- pointing the tests at Atlas -- would make them need an account, a
// network and somebody's credentials to run at all.
import { MongoMemoryServer } from 'mongodb-memory-server'

export async function startMongo() {
  const server = await MongoMemoryServer.create()
  return {
    uri: server.getUri(),
    stop: () => server.stop().catch(() => { /* going away anyway */ }),
  }
}
