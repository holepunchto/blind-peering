const ProtomuxRPC = require('protomux-rpc')
const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const Backoff = require('./backoff.js')
const waitForRPC = require('./wait-for-rpc.js')

const {
  CoreRecord
} = require('./messages.js')

module.exports = class BlindMirror extends ReadyResource {
  constructor (serverKey, opts = {}) {
    super()

    this.serverKey = HypercoreId.decode(serverKey)
    this.rpc = null
    this.suspended = !!opts.suspended

    this._connecting = null
    this._backoff = new Backoff([5000, 15000, 60000, 300000])

    this._dht = opts.dht || null
    this._pendingRPC = null
    this._autoDestroy = !opts.dht
    this._suspendedResolve = null
    this._suspended = this.suspended ? new Promise(resolve => { this._suspendedResolve = resolve }) : null

    this.ready().catch(safetyCatch)
  }

  async suspend () {
    if (this.suspended) return
    this.suspended = true
    this._suspended = new Promise(resolve => { this._suspendedResolve = resolve })
    this._backoff.destroy()
    if (this.rpc) this.rpc.destroy()
    if (this._pendingRPC) this._pendingRPC.destroy()
    await this.connect() // flush
  }

  async resume () {
    if (!this.suspended) return
    this.suspended = false
    this._backoff = new Backoff([5000, 15000, 60000, 300000])
    this.connect().catch(safetyCatch) // bg resume
    this._suspendedResolve()
    this._suspended = null
    this._suspendedResolve = null
  }

  async _open () {
    await Promise.resolve() // allow a tick to train so users can attach listeners
    await this.connect()
  }

  async close () {
    this._backoff.destroy()
    this.rpc.destroy()
    if (this._pendingRPC) this._pendingRPC.destroy()
    return super.close()
  }

  async _close () {
    if (this._connecting) await this._connecting // Debounce
    if (this._autoDestroy) await this._dht.destroy()
  }

  get key () {
    return this.rpc.stream.publicKey
  }

  get stream () {
    return this.rpc.stream
  }

  async connect () {
    if (this._connecting) return this._connecting

    this._connecting = this._connect()

    try {
      await this._connecting
    } finally {
      this._connecting = null
    }
  }

  async _connect () {
    if (this.rpc && !this.rpc.closed) return

    this._backoff.reset()

    while (!this.closing && !this.suspended) {
      if (this._dht.destroyed) return

      const socket = this._dht.connect(this.serverKey)
      socket.setKeepAlive(5000)

      const rpc = new ProtomuxRPC(socket, {
        id: this.serverKey,
        valueEncoding: c.none
      })
      rpc.once('close', () => socket.destroy())

      // always set this so we can nuke it if we want
      this._pendingRPC = rpc

      // Only the first time, set it without waiting
      if (this.rpc === null) {
        this.rpc = rpc
      }
      this.emit('stream', rpc.stream)

      try {
        await waitForRPC(rpc)
        this._pendingRPC = null
        this.rpc = rpc
        break
      } catch (err) {
        safetyCatch(err)
        this._pendingRPC = null

        if (this.closing || this.suspended) return

        await this._backoff.run()
      }
    }

    if (this.closing || this.suspended) return

    const socket = this.rpc.stream
    socket.once('close', () => this.connect().catch(safetyCatch))
  }

  async add (id, opts = {}) {
    if (this.opened === false) await this.opening

    const key = HypercoreId.decode(id)
    const referrer = opts.referrer ? HypercoreId.decode(opts.referrer) : null
    const autobase = opts.autobase || null

    while (!this.rpc && !this.closing) {
      await this.connect()
      if (this._suspended !== null) await this._suspended
    }

    if (this.closing) return

    await this.rpc.request('add-core', {
      key,
      referrer,
      autobase: autobase
        ? {
            key: autobase.key,
            blockEncryptionKey: autobase.blockEncryptionKey || null
          }
        : null
    }, { requestEncoding: CoreRecord, responseEncoding: c.none })
  }

  async ping () {
    if (this.opened === false) await this.opening
    if (this.suspended) await this._suspended

    await this.connect()

    return this.rpc.request('ping', null, { requestEncoding: c.none, responseEncoding: c.string })
  }
}
