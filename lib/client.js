const ProtomuxRPC = require('protomux-rpc')
const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const Signal = require('signal-promise')
const Backoff = require('./backoff.js')
const { AddCoreEncoding, DeleteCoreEncoding } = require('blind-peer-encodings')

class BlindPeerClient extends ReadyResource {
  constructor (remotePublicKey, dht, opts = {}) {
    super()

    this.remotePublicKey = HypercoreId.decode(remotePublicKey)
    this.rpc = null
    this.dht = dht
    this.suspended = !!opts.suspended
    this.keyPair = opts.keyPair || null
    this.relayThrough = opts.relayThrough || null
    this.connected = false
    this.backoffValues = opts.backoffValues || [1000, 1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000, 15000, 30000, 60000]

    this._connecting = null
    this._signal = new Signal()
    this._backoff = new Backoff(this.backoffValues)

    this.ready().catch(safetyCatch)
  }

  bump () {
    this._backoff.reset()
    this._backgroundConnect()
  }

  async suspend () {
    if (this.suspended) return
    this.suspended = true
    this._backoff.destroy()
    if (this.rpc) this.rpc.destroy()
    if (this._connecting) await this._connecting
  }

  async resume () {
    if (!this.suspended) return
    this.suspended = false
    this._backoff = new Backoff(this.backoffValues)
    this._backgroundConnect()
    this._signal.notify()
  }

  async _open () {
    // no need to set anything up (the connection is opened lazily)
  }

  async _close () {
    this._backoff.destroy()
    if (this.rpc) this.rpc.destroy()
    if (this._connecting) await this._connecting // Debounce
    this._signal.notify()
  }

  get key () {
    return this.rpc?.stream.publicKey || null
  }

  get stream () {
    return this.rpc?.stream || null
  }

  _backgroundConnect () {
    this.connect().catch(safetyCatch)
  }

  async connect () {
    if (!this.opened) await this.ready()

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

    this.connected = false
    this._backoff.reset()

    while (!this.closing && !this.suspended && !this.dht.destroyed) {
      const socket = this.dht.connect(this.remotePublicKey, { keyPair: this.keyPair, relayThrough: this.relayThrough })

      const rpc = new ProtomuxRPC(socket, {
        id: this.remotePublicKey,
        valueEncoding: c.none
      })
      rpc.on('close', () => socket.destroy())

      // always set this so we can nuke it if we want
      this.rpc = rpc
      this.emit('stream', rpc.stream)

      await socket.opened
      try {
        await rpc.fullyOpened()
      } catch (e) {
        safetyCatch(e)
      }

      if (!socket.destroying && !socket.destroyed && rpc.opened && !rpc.closed) break
      if (this.closing || this.suspended || this.dht.destroyed) break

      await this._backoff.run()
    }

    if (this.closing || this.suspended || this.dht.destroyed) return

    this.connected = true
    this._signal.notify()
  }

  async deleteCore (key) {
    key = HypercoreId.decode(key)
    const req = { key }

    let error = null

    for (let i = 0; i < this.backoffValues.length * 2; i++) {
      while (!this.closing && !this.connected) {
        this._backgroundConnect()
        await this._signal.wait()
      }

      if (this.closing) throw new Error('Closing')

      try {
        return await this.rpc.request(
          'delete-core',
          req,
          DeleteCoreEncoding
        )
      } catch (err) {
        error = err
      }
    }

    throw error
  }

  async addCore (id, opts = {}) {
    const key = HypercoreId.decode(id)
    const referrer = opts.referrer ? HypercoreId.decode(opts.referrer) : null
    const autobase = opts.autobase || null
    const priority = opts.priority || 0
    const announce = opts.announce === true

    const req = {
      key,
      referrer,
      deprecatedAutobase: autobase?.key || null,
      deprecatedAutobaseBlockKey: autobase?.blockEncryptionKey || null,
      priority,
      announce
    }

    let error = null

    for (let i = 0; i < this.backoffValues.length * 2; i++) {
      while (!this.closing && !this.connected) {
        this._backgroundConnect()
        await this._signal.wait()
      }

      if (this.closing) throw new Error('Closing')

      try {
        return await this.rpc.request(
          'add-core',
          req,
          AddCoreEncoding
        )
      } catch (err) {
        error = err
      }
    }

    throw error
  }

  isReplicating (core) {
    const muxer = this.stream && this.stream.userData
    if (!muxer) return Promise.resolve(false)

    const ch = muxer.getLastChannel({ protocol: 'hypercore', id: core.discoveryKey })
    if (ch) return ch.fullyOpened()

    const cha = muxer.getLastChannel({ protocol: 'hypercore/alpha', id: core.discoveryKey })
    if (cha) return cha.fullyOpened()

    return Promise.resolve(false)
  }
}

module.exports = BlindPeerClient
