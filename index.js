const BlindPeerMuxer = require('blind-peer-muxer')
const xorDistance = require('xor-distance')
const b4a = require('b4a')
const ID = require('hypercore-id-encoding')
const safetyCatch = require('safety-catch')
const Backoff = require('./lib/backoff.js')

const DEFAULT_BACKOFF = [1000, 1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000, 15000, 30000, 60000]
const MAX_BATCH_MIN = 32
const MAX_BATCH_MAX = 64

class BlindPeering {
  constructor(dht, store, opts = {}) {
    const {
      suspended = false,
      wakeup = null,
      keys = [],
      gcWait = 2000,
      pick = 2,
      relayThrough = null
    } = opts

    this.dht = dht
    this.store = store
    this.suspended = suspended
    this.closed = false
    this.wakeup = wakeup
    this.keys = keys.map(ID.decode)
    this.gcWait = gcWait
    this.pick = pick
    this.relayThrough = relayThrough
    this.blindPeers = new Map()

    this._gc = new Set()
    this._gcTimer = null
    this._runGCBound = this._runGC.bind(this)
    this._bumpBound = this.bump.bind(this)

    this.dht.on('network-change', this._bumpBound)
  }

  bump() {
    for (const peer of this.blindPeers.values()) {
      peer.bump()
    }
  }

  setKeys(keys) {
    this.keys = keys.map(ID.decode)
    // TODO: rebalance
  }

  _addGC(peer) {
    peer.gc = 1

    const empty = this._gc.size === 0
    this._gc.add(peer)

    if (empty) this._startGC()
  }

  _removeGC(peer) {
    peer.gc = 0
    this._gc.delete(peer)
  }

  _startGC() {
    if (this._gcTimer) clearInterval(this._gcTimer)
    this._gcTimer = setInterval(this._runGCBound, this.gcWait)
    if (this._gcTimer.unref) this._gcTimer.unref()
  }

  _stopGC() {
    if (!this._gcTimer) return
    clearInterval(this._gcTimer)
    this._gcTimer = null
  }

  async addAutobase(base, { target, referrer, priority, announce, pick = this.pick } = {}) {
    await base.ready()
    if (base.closing) return

    if (!target) target = base.wakeupCapability.key
    if (!referrer) referrer = target

    const all = []

    for (const key of getClosestMirrorList(target, this.keys, pick)) {
      const peer = this._getBlindPeer(key)
      peer.addAutobase(base, { referrer, priority, announce })
      all.push(peer)
    }

    for (const peer of all) await peer.connecting
  }

  _runGC() {
    const close = []
    for (const peer of this._gc) {
      const uploaded = peer.channel ? getBlocksUploadedTo(peer.channel.stream) : 0
      if (uploaded !== peer.uploaded) {
        peer.uploaded = uploaded
        peer.gc = peer.gc < 2 ? 1 : peer.gc - 1
        continue
      }
      peer.gc++
      // 10 strikes is ~4-8s of inactivity
      if (peer.gc >= 4) close.push(peer)
    }

    for (const peer of close) {
      const id = b4a.toString(peer.remotePublicKey, 'hex')
      this.blindPeers.delete(id)
      peer.destroy()
      this._gc.delete(peer)
    }

    if (this._gc.size === 0) this._stopGC()
  }

  _getBlindPeer(key) {
    const id = b4a.toString(key, 'hex')
    let peer = this.blindPeers.get(id)
    if (peer) return peer
    peer = new BlindPeer(this, key)
    this.blindPeers.set(id, peer)
    return peer
  }

  addAutobaseBackground(base, opts) {
    this.addAutobase(base, opts).catch(safetyCatch)
  }

  async addCore(core, { target, referrer, priority, announce, pick = this.pick } = {}) {
    await core.ready()
    if (core.closing) return

    if (!target) target = core.key

    const all = []

    for (const key of getClosestMirrorList(target, this.keys, pick)) {
      const peer = this._getBlindPeer(key)
      peer.addCore(core, { referrer, priority, announce })
      all.push(peer)
    }

    for (const peer of all) await peer.connecting
  }

  addCoreBackground(core, opts) {
    this.addCore(core, opts).catch(safetyCatch)
  }

  close() {
    this._stopGC()
    this.dht.off('network-change', this._bumpBound)
    for (const peer of this.blindPeers.values()) peer.destroy()
    this.blindPeers.clear()
    return Promise.resolve() // atm nothing async but keep signature
  }
}

class BlindPeer {
  constructor(peering, remotePublicKey) {
    this.peering = peering
    this.remotePublicKey = remotePublicKey
    this.gc = 0
    this.uploaded = 0
    this.connects = 0
    this.cores = new Map()
    this.bases = new Map()

    this.channel = null
    this.socket = null
    this.connected = false
    this.connecting = null
    this.suspended = peering.suspended
    this.destroyed = false
    this.needsFlush = false
    this.backoff = new Backoff(DEFAULT_BACKOFF)
  }

  async suspend() {
    if (this.suspended) return
    this.suspended = true
    this.backoff.destroy()
    if (this.channel) this.channel.close()
    if (this.socket) this.socket.destroy()
    if (this.connecting) await this._connecting
  }

  async resume() {
    if (!this.suspended) return
    this.suspended = false
    this.backoff = new Backoff(DEFAULT_BACKOFF)
    this.update()
  }

  bump({ force = false } = {}) {
    if (this.suspended || this.destroyed) return
    if (force && this.channel) this.channel.close()
    else if (this.socket) this.socket.sendKeepAlive()
    const backoff = this.backoff
    this.backoff = new Backoff(DEFAULT_BACKOFF)
    backoff.destroy()
    this.update()
  }

  async connect() {
    if (this.connecting) return this.connecting
    if (this.connected) return

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
    return !this.destroyed && !this.suspended && !this.peering.dht.destroyed && this.hasRef()
  }

  async _connect() {
    this.backoff.reset()
    this.connects++
    this.needsFlush = true

    for (let runs = 0; this._active(); runs++) {
      if (runs > 0) {
        await this.backoff.run()
        if (!this._active()) break
      }

      const socket = this.peering.dht.connect(this.remotePublicKey, {
        keyPair: this.peering.keyPair,
        relayThrough: this.peering.relayThrough
      })

      const channel = new BlindPeerMuxer(socket, {
        onclose: (remote) => {
          const connected = this.connected
          socket.destroy()
          this.connected = false
          if (connected && this._active()) this._backgroundConnect()
        }
      })

      // always set this so we can nuke it if we want
      this.socket = socket
      this.channel = channel
      this.onstream(socket)

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

    this.update()
  }

  hasRef() {
    return this.cores.size + this.bases.size > 0
  }

  _flushCore(core, info) {
    const batch = {
      priority: info.priority,
      referrer: info.referrer,
      announce: info.announce,
      cores: [],
      visited: new Set()
    }

    addCore(batch, core.key, core.length)
    info.flushed = this.connects
    this.channel.addCores(batch)
  }

  _flushAutobase(base, info) {
    const batch = {
      priority: info.priority,
      referrer: info.referrer,
      announce: info.announce,
      cores: [],
      visited: new Set()
    }

    addAllCores(batch, base, false)
    info.flushed = this.connects
    this.channel.addCores(batch)
  }

  _flush() {
    if (!this.connected) return

    this.needsFlush = false

    const total = this.cores.size + this.bases.size

    if (total > 1) this.channel.cork()

    for (const [core, info] of this.cores) {
      if (info.flushed === this.connects) continue
      this._flushCore(core, info)
    }

    for (const [base, info] of this.bases) {
      if (info.flushed === this.connects) continue
      this._flushAutobase(base, info)
    }

    if (total > 1) this.channel.uncork()
  }

  update() {
    if (this.destroyed || this.suspended || this.peering.dht.destroyed) return

    if (this.hasRef() && !this.connected) {
      this._backgroundConnect()
    }

    if (this.connected && this.needsFlush) {
      this._flush()
    }

    if (this.hasRef()) {
      if (this.gc) this.peering._removeGC(this)
    } else {
      if (!this.gc) this.peering._addGC(this)
    }
  }

  onstream(stream) {
    this.peering.store.replicate(stream)
    if (this.peering.wakeup) this.peering.wakeup.addStream(stream)
  }

  addCore(core, { referrer = null, priority = 1, announce = false } = {}) {
    if (this.cores.has(core)) return

    const info = { priority, announce, referrer, flushed: 0 }
    this.cores.set(core, info)

    core.on('close', () => {
      if (this.cores.get(core) !== info) return
      this.cores.delete(core)
      this.update()
    })

    if (this.connected) this._flushCore(core, info)

    this.update()
  }

  addAutobase(base, { referrer = null, priority = 1, announce = false } = {}) {
    if (this.bases.has(base)) return

    const info = { priority, announce, referrer, flushed: 0 }
    this.bases.set(base, info)

    base.on('close', () => {
      this.bases.delete(base)
      this.update()
    })

    base.on('writer', (writer) => {
      if (this.cores.has(writer.core)) return
      // TODO: what we should do here instead is wait a bit and see if the blind peer
      // is swarming this writer with us, if not, addCore it. mega scale
      this.addCore(writer.core, { referrer, priority })
    })

    base.core.on('migrate', () => {
      this._mirrorAutobase(base)
    })

    if (this.connected) this._flushAutobase(base, info)

    this.update()
  }

  destroy() {
    this.destroyed = true
    this.backoff.destroy()
    if (this.channel) this.channel.close()
    if (this.socket) this.socket.destroy()
  }
}

module.exports = BlindPeering

function addAllCores(batch, base, all) {
  addCore(batch, base.local.key, base.local.length)

  for (const view of base.views()) {
    addCore(batch, view.key, view.length)
  }

  const overflow = []

  for (const writer of base.activeWriters) {
    if (isStaticCore(writer.core) || all || batch.cores.length < MAX_BATCH_MIN) {
      addCore(batch, writer.core.key, writer.core.length)
    } else {
      overflow.push(writer.core)
    }
  }

  for (let i = 0; i < overflow.length && batch.cores.length < MAX_BATCH_MAX; i++) {
    const next = i + Math.floor(Math.random() * (overflow.length - i))
    const core = overflow[next]
    addCore(batch, core.key, core.length)
    overflow[next] = overflow[i]
  }
}

function addCore(batch, key, length) {
  const id = b4a.toString(key, 'hex')

  if (batch.visited.has(id)) return
  batch.visited.add(id)

  batch.cores.push({ key, length })
}

function isStaticCore(core) {
  return !!core.manifest && core.manifest.signers.length === 0
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

function getClosestMirrorList(key, list, n) {
  if (!list || !list.length) return []

  if (n > list.length) n = list.length

  for (let i = 0; i < n; i++) {
    let current = null
    for (let j = i; j < list.length; j++) {
      const next = xorDistance(list[j], key)
      if (current && xorDistance.gt(next, current)) continue
      const tmp = list[i]
      list[i] = list[j]
      list[j] = tmp
      current = next
    }
  }

  return list.slice(0, n)
}
