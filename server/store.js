// What survives a restart.
//
// A room is one document, with its co-owners, its bans and its conversation inside it. That is not how
// the same data looked in tables, and the difference is the main reason a document database is workable
// here at all: with no foreign keys there is no cascade, so anything kept in a second collection has to
// be deleted by hand, and every bug in that hand-written cleanup leaves rubbish behind for good. Held in
// one document, deleting a room is one operation that either happened or did not.
//
// Files will be the exception and have to be, because their bytes live on a disk no database can clean
// up for you. That step is explicit whichever database this is, so it may as well be its own collection.
//
// Every access goes through this file. It was written that way while the storage was SQLite, and
// replacing it was a change here and nowhere else -- which is the whole argument for the shape.
import { MongoClient } from 'mongodb'

// A hundred is what a room ever shows. Mongo caps the array as it pushes, so the document cannot grow
// past it and there is no sweep to forget to run.
const MESSAGE_LIMIT = 100

// No connection string configured is the same situation as one that cannot be reached: there is nowhere
// to keep a permanent room, and everything else -- signalling, sharing a screen, talking, temporary
// rooms -- carries on untouched. Throwing here instead would have made a server with no database at all
// refuse to start, which is a strange way to punish somebody who only wants to share their screen.
const unavailable = (reason) => ({
  connect: () => Promise.reject(new Error(reason)),
  loadRooms: () => Promise.resolve([]),
  readMessages: () => Promise.resolve([]),
  saveRoom: () => Promise.resolve(),
  deleteRoom: () => Promise.resolve(),
  touchRoom: () => Promise.resolve(),
  setPendingDeletion: () => Promise.resolve(),
  addBan: () => Promise.resolve(),
  addCoOwner: () => Promise.resolve(),
  removeCoOwner: () => Promise.resolve(),
  addMessage: () => Promise.resolve(),
  addFile: () => Promise.resolve(),
  listFiles: () => Promise.resolve([]),
  deleteFile: () => Promise.resolve(),
  removeMessageWithFile: () => Promise.resolve(),
  findFile: () => Promise.resolve(null),
  roomUsage: () => Promise.resolve(0),
  deleteFilesForRoom: () => Promise.resolve(),
  flush: () => Promise.resolve(),
  close: () => Promise.resolve(),
})

export function createStore({ uri = process.env.MONGODB_URI, database = process.env.MONGODB_DB || 'telasshare' } = {}) {
  if (!uri) return unavailable('MONGODB_URI is not set')
  const client = new MongoClient(uri, {
    // The list is read once at boot and written a handful of times a minute after that, so a small pool
    // is right. The timeout is there so a database that is unreachable fails quickly and loudly rather
    // than leaving people looking at a page that never loads.
    maxPoolSize: 5,
    serverSelectionTimeoutMS: 8_000,
  })
  let rooms = null
  let files = null

  // Writes are queued rather than awaited by the caller. Every room is held in memory and answered from
  // there -- the database is the durable copy, not what the server consults during a session -- so
  // making the signalling path wait on a network round trip to another continent would slow the room
  // down to buy nothing. The queue is what keeps them in order: a deletion must not overtake the message
  // sent a moment before it.
  let queue = Promise.resolve()
  const write = (label, run) => {
    queue = queue.then(run).catch((error) => {
      // Losing a write is bad; losing it silently is worse. There is nothing useful to do here beyond
      // saying so plainly -- the room in memory is still right, and the next write will try again.
      console.error(`Could not persist ${label}:`, error.message)
    })
    return queue
  }

  const shape = (document) => ({
    key: document._id,
    id: document.id,
    name: document.name,
    password: document.password ?? null,
    ownerSub: document.ownerSub,
    ownerName: document.ownerName || '',
    permanent: document.permanent === true,
    createdAt: document.createdAt,
    lastSeenAt: document.lastSeenAt ?? document.createdAt,
    deleteAfter: document.deleteAfter ?? null,
    deleteBy: document.deleteBy ?? null,
    deleteByName: document.deleteByName ?? null,
    bannedNames: new Set(document.bannedNames || []),
    coOwners: new Map((document.coOwners || []).map((owner) => [owner.sub, owner.name])),
    messages: document.messages || [],
  })

  return {
    async connect() {
      await client.connect()
      const db = client.db(database)
      rooms = db.collection('rooms')
      // Files are the one thing not held inside the room document, and they have to be: their bytes sit
      // on a disk that no database deletes for you, so that cleanup is explicit either way.
      files = db.collection('files')
      await files.createIndex({ roomKey: 1, at: 1 })
      // The room's own key is the document's identifier, so two requests arriving together cannot both
      // create it -- the database refuses the second rather than the server having to notice.
      await rooms.createIndex({ id: 1 }, { unique: true })
    },

    // Everything at once, at boot, conversations included. There is no paging: a lobby nobody can page
    // through is not a lobby.
    async loadRooms() {
      return (await rooms.find({}).toArray()).map(shape)
    },

    // Only what can change. The creator and the creation date are written once, so no later save can
    // quietly rewrite who made the room.
    saveRoom(key, room) {
      return write(`room ${key}`, () => rooms.updateOne(
        { _id: key },
        {
          $set: {
            id: room.id,
            name: room.name,
            password: room.password ?? null,
            permanent: room.permanent === true,
            lastSeenAt: room.lastSeenAt ?? room.createdAt,
          },
          $setOnInsert: {
            ownerSub: room.ownerSub,
            ownerName: room.ownerName ?? '',
            createdAt: room.createdAt,
            coOwners: [],
            bannedNames: [],
            messages: [],
          },
        },
        { upsert: true },
      ))
    },

    // One operation, and the conversation, the co-owners and the bans go with it.
    deleteRoom(key) {
      return write(`deletion of ${key}`, () => rooms.deleteOne({ _id: key }))
    },

    touchRoom(key, at) {
      return write(`visit to ${key}`, () => rooms.updateOne({ _id: key }, { $set: { lastSeenAt: at } }))
    },

    setPendingDeletion(key, deleteAfter, by, byName) {
      return write(`countdown on ${key}`, () => rooms.updateOne({ _id: key }, {
        $set: { deleteAfter: deleteAfter ?? null, deleteBy: by ?? null, deleteByName: byName ?? null },
      }))
    },

    addBan(key, name) {
      return write(`ban in ${key}`, () => rooms.updateOne({ _id: key }, { $addToSet: { bannedNames: name } }))
    },

    // Anything matching either the session or the name is taken out first, so appointing the same person
    // twice from two machines leaves one entry rather than two.
    addCoOwner(key, sub, name) {
      return write(`co-owner of ${key}`, async () => {
        await rooms.updateOne({ _id: key }, { $pull: { coOwners: { $or: [{ sub }, { name }] } } })
        await rooms.updateOne({ _id: key }, { $push: { coOwners: { sub, name } } })
      })
    },

    // Reaches the name as well as the session, or somebody unappointed would still be a co-owner from
    // anywhere else they had signed in.
    removeCoOwner(key, sub, name) {
      return write(`co-owner removal in ${key}`, () => rooms.updateOne(
        { _id: key },
        { $pull: { coOwners: { $or: [{ sub }, { name: name ?? '' }] } } },
      ))
    },

    // Pushed and capped in the same operation, so the array cannot outgrow what a room shows.
    addMessage(key, message, keep = MESSAGE_LIMIT) {
      return write(`message in ${key}`, () => rooms.updateOne(
        { _id: key },
        { $push: { messages: { $each: [message], $slice: -keep } } },
      ))
    },

    addFile(file) {
      // Awaited by its caller, unlike a chat line: bytes are already on the disk by this point, and a
      // row that never arrives is a file nobody can reach and nobody can delete.
      return write(`file in ${file.roomKey}`, () => files.insertOne({ _id: file.id, ...file }))
    },

    async listFiles(roomKey) {
      return (await files.find({ roomKey }).sort({ at: 1 }).toArray()).map(({ _id, ...rest }) => ({ id: _id, ...rest }))
    },

    async findFile(id) {
      const document = await files.findOne({ _id: id })
      return document ? { id: document._id, ...document } : null
    },

    // What the room has already spent, asked of the database rather than counted in memory so a restart
    // cannot lose track of it.
    async roomUsage(roomKey) {
      const [row] = await files.aggregate([
        { $match: { roomKey } },
        { $group: { _id: null, bytes: { $sum: '$bytes' } } },
      ]).toArray()
      return row?.bytes || 0
    },

    deleteFile(id) {
      return write(`file ${id}`, () => files.deleteOne({ _id: id }))
    },

    // The message that carried the file goes with it. Without this the conversation would keep a line
    // pointing at nothing, which reads as a bug to everyone who sees it.
    removeMessageWithFile(key, fileId) {
      return write(`message of file ${fileId}`, () => rooms.updateOne(
        { _id: key },
        { $pull: { messages: { 'file.id': fileId } } },
      ))
    },

    deleteFilesForRoom(roomKey) {
      return write(`files of ${roomKey}`, () => files.deleteMany({ roomKey }))
    },

    async readMessages(key) {
      const document = await rooms.findOne({ _id: key }, { projection: { messages: 1 } })
      return document?.messages || []
    },

    // Somewhere to wait for the queue to drain. A test needs it, and so does shutting down without
    // dropping the write that was in flight.
    flush() { return queue },

    async close() {
      await queue
      await client.close()
    },
  }
}
