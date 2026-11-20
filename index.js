const BlindPeerMuxer = require('blind-peer-muxer')
const b4a = require('b4a')
const HyperDHTAddress = require('hyperdht-address')
const safetyCatch = require('safety-catch')
const Backoff = require('./lib/backoff.js')
const os = require('os')
const { version } = require('./package.json')
const rrp = require('resolve-reject-promise')
const DEFAULT_BACKOFF = [
  0, 1000, 1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000, 15000, 30000, 60000
]

class BlindPeering {
  /**
   * @param {import('hyperdht')} dht
   * @param {import('corestore')} store
   */
  constructor(dht, store, opts = {}) {
    const {
      suspended = false,
      wakeup = null,
      gcWait = 2000,
      relayThrough = null,
      backoffResetWait = 10000,
      client = null,
      skipConnectionMetadata = false
    } = opts

    this.dht = dht
    this.store = store
    this.suspended = suspended
    this.closed = false
    this.wakeup = wakeup
    /** @type {Map<string, BlindPeer>} */
    this.blindPeers = new Map()

    this.gcWait = gcWait
    this.relayThrough = relayThrough
    this.backoffResetWait = backoffResetWait

    this.stats = {
      addCore: 0,
      addCoresTx: 0
    }

    this._handshake = {}
    if (!skipConnectionMetadata) {
      this._handshake.blindPeeringVersion = version
      this._handshake.clientName = client?.name
      this._handshake.clientVersion = client?.version
      this._handshake.osPlatform = os.platform()
    }
    /** @type {Map<BlindPeer, { idleTicks: number, uploaded: number }>} */
    this._gc = new Map()
    this._gcTimer = null
    this._runGCBound = this._runGC.bind(this)

    this._onDhtClose = () => this.close()
    this.dht.on('close', this._onDhtClose)
  }

  /**
   * @param {import('hypercore')} core
   * @param {Array<Buffer>} blindPeers Array of HyperDHTAddress encoded buffers
   */
  async addCore(core, blindPeers, { referrer = null, priority = undefined } = {}) {
    const keys = this._getBlindPeerKeys(blindPeers)

    await core.ready()
    if (core.closing) return Promise.reject('Core closed')
    if (this.closed) return Promise.reject('BlindPeering closed')

    const peers = keys.map((x) => this._getBlindPeer(x))
    try {
      await Promise.all(peers.map((peer) => peer.addCore(core, { referrer, priority })))
    } catch (err) {
      const publicKey = b4a.toString(core.key, 'hex')
      for (const peer of peers) peer.cores.get(publicKey)?.destroy(err)
      throw err
    }
  }

  close() {
    if (this.closed) return
    this._stopGC()
    this._gc = new Map()
    this.dht.off('close', this._onDhtClose)
    for (const peer of this.blindPeers.values()) peer.destroy('BlindPeering was closed')
    this.closed = true
    return Promise.resolve() // atm nothing async but keep signature
  }

  suspend() {
    this.suspended = true
    this._stopGC()
    return Promise.all([...this.blindPeers.values()].map((peer) => peer.suspend()))
  }

  resume() {
    this.suspended = false
    if (this._gc.size) this._startGC()
    return Promise.all([...this.blindPeers.values()].map((peer) => peer.resume()))
  }

  _addGC(peer) {
    if (this._gc.has(peer)) return
    this._gc.set(peer, { idleTicks: 0, uploaded: getBlocksUploadedTo(peer.channel?.stream) })
    if (!this.suspended) this._startGC()
  }

  _removeGC(peer) {
    this._gc.delete(peer)
    if (this._gc.size === 0) this._stopGC()
  }

  _startGC() {
    if (this._gcTimer) return
    this._gcTimer = setInterval(this._runGCBound, this.gcWait)
    if (this._gcTimer.unref) this._gcTimer.unref()
  }

  _stopGC() {
    if (!this._gcTimer) return
    clearInterval(this._gcTimer)
    this._gcTimer = null
  }

  _runGC() {
    for (const [peer, state] of this._gc) {
      const uploaded = getBlocksUploadedTo(peer.channel?.stream)
      if (uploaded !== state.uploaded) {
        state.uploaded = uploaded
        state.idleTicks = 0
      } else if (++state.idleTicks >= 3) {
        this._removeGC(peer)
        this.blindPeers.delete(peer.key)
        peer.destroy('Garbage collected')
      }
    }
  }

  /**
   * @returns {BlindPeer}
   */
  _getBlindPeer(decodedBlindPeer) {
    let peer = this.blindPeers.get(decodedBlindPeer.key)
    if (peer) return peer
    peer = new BlindPeer(this, decodedBlindPeer.key, decodedBlindPeer.encodedKey, {
      backoffResetWait: this.backoffResetWait
    })
    this.blindPeers.set(decodedBlindPeer.key, peer)
    return peer
  }

  _getBlindPeerKeys(blindPeers) {
    return blindPeers.map((encodedKey) => ({
      key: b4a.toString(HyperDHTAddress.decode(encodedKey).key, 'hex'),
      encodedKey
    }))
  }
}

class BlindPeer {
  /**
   * @param {BlindPeering} peering
   */
  constructor(peering, key, encodedAddress, { backoffResetWait }) {
    this.peering = peering
    this.key = key
    this.encodedAddress = encodedAddress
    this.connects = 0
    this.cores = new Map()

    this.channel = null
    this.socket = null
    this.connected = false
    this.connecting = null
    this.suspended = peering.suspended
    this.destroyed = false
    this.backoff = new Backoff(DEFAULT_BACKOFF)
    this.backoffResetWait = backoffResetWait
  }

  async addCore(core, { referrer, priority }) {
    const publicKey = b4a.toString(core.key, 'hex')
    const current = this.cores.get(publicKey)
    if (current) return await current.sending.promise

    this.peering.stats.addCore++

    const info = {
      core: core.session({ weak: true }),
      args: { priority, referrer },
      sending: { ...rrp(), connection: -1 },
      response: null, // { connection, length, activated } of the latest response
      retry: new Backoff(DEFAULT_BACKOFF),
      destroyed: false,
      destroy: (reason) => {
        if (info.destroyed) return
        info.destroyed = true
        info.retry.destroy()
        info.sending.reject(reason)
        this.cores.delete(publicKey)
        info.core.off('close', onclose)
        info.core.close().catch(safetyCatch)
        this._updateGC()
      }
    }
    info.sending.promise.catch(noop)

    const onclose = () => info.destroy('core closed')
    info.core.on('close', onclose)

    this.cores.set(publicKey, info)
    this._updateGC()

    this._backgroundConnect()
    if (this.connected) this._flushCore(info)

    return await info.sending.promise
  }

  async suspend() {
    if (this.suspended) return
    this.suspended = true
    this.backoff.destroy()
    if (this.channel) this.channel.close()
    if (this.socket) this.socket.destroy()
    if (this.connecting) await this.connecting
  }

  async resume() {
    if (!this.suspended) return
    this.suspended = false
    this.backoff = new Backoff(DEFAULT_BACKOFF)
    if (this.cores.size) this._backgroundConnect()
  }

  async connect() {
    if (this.connecting) return this.connecting
    if (this.connected || !this._active()) return

    this.connecting = this._connect()

    try {
      await this.connecting
    } finally {
      this.connecting = null
    }
  }

  _backgroundConnect() {
    this.connect().catch(safetyCatch)
  }

  _active() {
    return !this.destroyed && !this.suspended && this.hasRef()
  }

  hasRef() {
    return this.cores.size > 0
  }

  _updateGC() {
    if (this.destroyed) return
    if (this.hasRef()) this.peering._removeGC(this)
    else this.peering._addGC(this)
  }

  async _connect() {
    this.connects++

    while (this._active()) {
      await this.backoff.run()
      if (!this._active()) break

      const socket = this.peering.dht.connect(this.encodedAddress, {
        relayThrough: this.peering.relayThrough
      })

      const channel = new BlindPeerMuxer(socket, {
        handshake: this.peering._handshake,
        onclose: () => {
          const connected = this.connected
          socket.destroy()
          this.connected = false
          if (connected && this._active()) this._backgroundConnect()
        }
      })

      this.socket = socket
      this.channel = channel
      this.peering.store.replicate(socket)
      this.peering.wakeup?.addStream(socket)

      await socket.opened

      // check if all is good
      if (!socket.destroying && !socket.destroyed) {
        this.connected = true
        break
      }
    }

    if (!this.connected || !this._active()) {
      this.connected = false
      if (this.channel) this.channel.close()
      return
    }

    const connectAttempt = this.connects
    setTimeout(() => {
      if (this.destroyed) return
      const stayedConnected = connectAttempt === this.connects
      if (stayedConnected) this.backoff.reset() // Otherwise the connection probably errored, so avoid reconnect loop
    }, this.backoffResetWait).unref()

    this._flush()
  }

  async _flushCore(info) {
    const connection = this.connects
    try {
      const coresMessage = {
        ...info.args,
        cores: [{ key: info.core.key, length: info.core.length }]
      }
      info.sending.connection = connection
      const response = await this._requestAddCores(coresMessage)
      // response from an old connection, the new one re-sends
      if (connection !== this.connects) return

      const entry = response.cores.find((c) => b4a.equals(c.key, info.core.key))
      info.response = { connection, length: entry.length, activated: entry.activated }
      info.retry.reset()
      info.sending.resolve()
    } catch (err) {
      if (info.destroyed) return
      if (connection !== this.connects || this.suspended) {
        // failed due to underlying connection changing or suspending
        // so we do not reject, it will try again on new connection
        return
      }
      if (isRecoverable(err)) {
        await info.retry.run()
        // a reconnect in the meantime already re-sent it
        if (info.destroyed || !this.connected || connection !== this.connects) return
        this._flushCore(info)
        return
      }
      info.destroy(err)
    }
  }

  async _requestAddCores(message) {
    this.peering.stats.addCoresTx++
    return await this.channel.requestAddCores(message)
  }

  _flush() {
    if (!this.connected) return

    this.channel.cork()
    for (const info of this.cores.values()) {
      if (info.sending.connection !== this.connects) this._flushCore(info)
    }
    this.channel.uncork()
  }

  destroy(reason) {
    this.destroyed = true
    for (const info of this.cores.values()) info.destroy(reason)
    this.backoff.destroy()
    if (this.channel) this.channel.close()
    if (this.socket) this.socket.destroy()
  }
}

function isRecoverable(err) {
  return err?.code === 'RATE_LIMITED' || err?.code === 'REQUEST_TIMEOUT'
}

function getBlocksUploadedTo(stream) {
  if (!stream || !stream.userData) return 0
  let uploadedTotal = 0
  for (const ch of stream.userData) {
    if (!ch || !ch.userData || !ch.userData.wireData) continue
    uploadedTotal += ch.userData.stats.wireData.tx
  }
  return uploadedTotal
}

function noop() {}

module.exports = BlindPeering
