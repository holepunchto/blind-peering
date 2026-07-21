const BlindPeerMuxer = require('blind-peer-muxer')
const xorDistance = require('xor-distance')
const b4a = require('b4a')
const hcCrypto = require('hypercore-crypto')
const ID = require('hypercore-id-encoding')
const HyperDHTAddress = require('hyperdht-address')
const safetyCatch = require('safety-catch')
const Backoff = require('./lib/backoff.js')

const DEFAULT_BACKOFF = [1000, 1000, 1000, 2000, 2000, 3000, 3000, 5000, 5000, 15000, 30000, 60000]
const MAX_BATCH_MIN = 3
const MAX_BATCH_MAX = 9
const BATCH_IDLE_WAIT = 2000
const BATCH_MAX_WAIT = 10_000

class BlindPeering {
  constructor(dht, store, opts = {}) {
    const {
      suspended = false,
      wakeup = null,
      keys = [],
      gcWait = 2000,
      pick = 2,
      relayThrough = null,
      maxBatchMin = MAX_BATCH_MIN,
      maxBatchMax = MAX_BATCH_MAX,
      batchIdleWait = BATCH_IDLE_WAIT,
      batchMaxWait = BATCH_MAX_WAIT
    } = opts

    this.dht = dht
    this.store = store
    this.suspended = suspended
    this.closed = false
    this.wakeup = wakeup
    this.blindPeers = new Map()

    // TODO: on a next major, get rid of all the work arounds
    // for making it support both hyperdht-encoded addresses
    // and straight keys (by always using hyperdht-encoded ones)
    this.keyToEncodedKey = null // set next line
    this.setKeys(keys)

    this.gcWait = gcWait
    this.pick = pick
    this.relayThrough = relayThrough
    this.maxBatchMin = maxBatchMin
    this.maxBatchMax = maxBatchMax
    this.batchIdleWait = batchIdleWait
    this.batchMaxWait = batchMaxWait

    this.stats = {
      addAutobase: 0,
      addCore: 0,
      addCoresTx: 0,
      notificationsTx: 0
    }

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

  get keys() {
    return Array.from(this.keyToEncodedKey.keys())
  }

  setKeys(keys) {
    this.keyToEncodedKey = getKeysMap(keys)

    const uniqueCores = new Map()
    const uniqueBases = new Map()
    for (const bp of this.blindPeers.values()) {
      for (const [core, info] of bp.cores) {
        uniqueCores.set(core, info)
      }
      for (const [base, info] of bp.bases) {
        uniqueBases.set(base, info)
      }
    }

    for (const [core, info] of uniqueCores) {
      this.addCoreBackground(core, info)
    }
    for (const [base, info] of uniqueBases) {
      this.addAutobaseBackground(base, info)
    }
  }

  suspend() {
    this.suspended = true
    this._stopGC()

    const suspending = []
    for (const bp of this.blindPeers.values()) {
      suspending.push(bp.suspend())
    }
    return Promise.all(suspending)
  }

  resume() {
    this.suspended = false
    if (this._gc.size) this._startGC()

    const resuming = []
    for (const bp of this.blindPeers.values()) {
      resuming.push(bp.resume())
    }
    return Promise.all(resuming)
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

  async addAutobase(
    auto,
    {
      target,
      referrer,
      priority,
      announce,
      additionalViews,
      pick = this.pick,
      keys = this.keys
    } = {}
  ) {
    await auto.ready()
    if (auto.closing) return

    if (!target) target = auto.wakeupCapability.key
    if (!referrer) referrer = target

    const all = []

    for (const key of getClosestMirrorList(target, keys, pick)) {
      const peer = this._getBlindPeer(this.keyToEncodedKey.get(key) || key)
      peer.addAutobase(auto, { target, referrer, priority, announce, additionalViews, pick })
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

  addAutobaseBackground(auto, opts) {
    this.addAutobase(auto, opts).catch(safetyCatch)
  }

  async addCore(
    core,
    { target, referrer, priority, announce, pick = this.pick, keys = this.keys } = {}
  ) {
    await core.ready()
    if (core.closing) return

    if (!target) target = core.key

    const all = []

    for (const key of getClosestMirrorList(target, keys, pick)) {
      const peer = this._getBlindPeer(this.keyToEncodedKey.get(key) || key)
      peer.addCore(core, { target, referrer, priority, announce, pick })
      all.push(peer)
    }

    for (const peer of all) await peer.connecting
  }

  addCoreBackground(core, opts) {
    this.addCore(core, opts).catch(safetyCatch)
  }

  async sendNotification(
    core,
    {
      roomKey = core.key,
      roomDiscoveryKey = hcCrypto.discoveryKey(roomKey),
      index = null,
      target = core.key,
      keys = this.keys,
      extra = null,
      appId = null
    } = {}
  ) {
    await core.ready()
    if (index === null) index = core.length - 1

    const request = {
      block: {
        key: core.key,
        index
      },
      destination: {
        key: roomKey,
        discoveryKey: roomDiscoveryKey
      },
      extra,
      appId
    }

    const closestKeys = getClosestMirrorList(target, keys, this.pick)
    const peers = closestKeys.map((key) => this._getBlindPeer(key))
    const connectedPeer = peers.find((peer) => peer.connected)
    if (connectedPeer) {
      await connectedPeer.sendNotification(request)
      return
    }
    for (const peer of peers) {
      try {
        await peer.sendNotification(request)
        return
      } catch (e) {
        safetyCatch(e)
      }
    }
    throw new Error('No peers available')
  }

  sendNotificationBackground(core, opts) {
    this.sendNotification(core, opts).catch(safetyCatch)
  }

  close() {
    this._stopGC()
    this._gc = new Set()
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
    this.pendingNotifications = 0
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

    this._pendingFlushes = new Map()
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
    return this.cores.size + this.bases.size > 0 || this.pendingNotifications > 0
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
    this.peering.stats.addCoresTx++ // TODO: track elsewhere
  }

  _flushAutobase(auto, info, visited = new Set()) {
    const viewBatch = {
      priority: info.priority,
      referrer: null,
      announce: info.announce,
      cores: [],
      visited
    }

    const writerBatch = {
      priority: info.priority,
      referrer: info.referrer,
      announce: info.announce,
      cores: [],
      visited
    }

    addViewCores(
      viewBatch,
      auto,
      this.peering.maxBatchMin,
      this.peering.maxBatchMax,
      info.additionalViews
    )

    addWriterCores(writerBatch, auto, this.peering.maxBatchMin, this.peering.maxBatchMax)

    info.flushed = this.connects

    if (writerBatch.cores.length + viewBatch.cores.length === 0) return

    this.channel.addCores(writerBatch)
    this.channel.addCores(viewBatch)

    this.peering.stats.addCoresTx += 2 // TODO: track elsewhere
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

    for (const [auto, info] of this.bases) {
      if (info.flushed === this.connects) continue
      this._flushAutobase(auto, info)
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

  addCore(core, { target, referrer = null, priority = 0, announce = false, pick } = {}) {
    if (this.cores.has(core)) {
      // Handles an edge case when both sides have a corestore in passive mode,
      // in which case we need to explicitly send a new request to make
      // the blind-peer activate replication with us
      const isReplicating = core.peers.some((peer) =>
        b4a.equals(peer.remotePublicKey, this.remotePublicKey)
      )
      if (isReplicating) return
    }
    this.peering.stats.addCore++

    const info = { priority, announce, referrer, target, pick, flushed: 0 }
    this.cores.set(core, info)

    core.on('close', () => {
      if (this.cores.get(core) !== info) return
      this.cores.delete(core)
      this.update()
    })

    if (this.connected) this._flushCore(core, info)

    this.update()
  }

  addAutobase(
    auto,
    { target, referrer = null, priority = 1, announce = false, additionalViews = [], pick } = {}
  ) {
    if (this.bases.has(auto)) return
    this.peering.stats.addAutobase++

    const info = {
      priority,
      announce,
      referrer,
      additionalViews,
      target,
      pick,
      flushed: 0,
      flushedWriterBatch: false,
      flushTimeout: null,
      maxTimeout: null,
      cleanup: () => {
        this._pendingFlushes.delete(auto)
        clearTimeout(info.flushTimeout)
        clearTimeout(info.maxTimeout)
        auto.off('writer', onwriter)
      }
    }
    this.bases.set(auto, info)

    const visited = new Set() // to avoid duplicates when sending the writer batch

    const onwriter = () => {
      if (info.flushedWriterBatch) return // race condition
      clearTimeout(info.flushTimeout)
      info.flushTimeout = setTimeout(flushWriterBatch, this.peering.batchIdleWait)
    }

    const flushWriterBatch = () => {
      if (this.destroyed) return
      if (info.flushedWriterBatch) return
      info.flushedWriterBatch = true
      info.cleanup()
      if (this.connected) {
        this._flushAutobase(auto, info, visited)
      } else {
        this.update()
      }
    }

    auto.on('close', () => {
      info.cleanup() // We can't reasonable flush anymore: no guarantees on core lengths etc of closed cores
      this.bases.delete(auto)
      this.update()
    })

    // autobase only
    if (auto.core) {
      auto.core.on('migrate', () => {
        // TODO: cleanly
        // Context: the views have not yet rotated after 'migrate' triggers. For that, we need to wait for the 'reboot' event.
        // But 'reboot' is emitted for more reasons than just migration, so directly listening on it overtriggers.
        // This hack makes it so that in practice we only flush after the reboot
        setTimeout(() => {
          if (this.peering.closed) return
          if (this.connected) {
            return this._flushAutobase(auto, info)
          }
          return this.update()
        }, 500).unref()
      })
    }

    if (this.connected) {
      // TODO: look into passing visited for the not-connected case (to dedup writers for that case too)
      this._flushAutobase(auto, info, visited)
    }

    // Optimisation: schedule a second flush for any additional writer cores we discover
    // Note: we only do this once. Writers appearing later need to be added by others
    this._pendingFlushes.set(auto, info)
    info.maxTimeout = setTimeout(flushWriterBatch, this.peering.batchMaxWait)
    info.flushTimeout = setTimeout(flushWriterBatch, this.peering.batchIdleWait)
    auto.on('writer', onwriter)

    this.update()
  }

  async sendNotification(request) {
    this.pendingNotifications++
    try {
      if (!this.connected) {
        // Don’t wait for the full retry duration. Fail fast so the caller can switch to another blind-peer
        let timeout = null

        try {
          await Promise.race([
            this.connect(),
            new Promise((resolve, reject) => {
              timeout = setTimeout(() => {
                reject(new Error('Timed out'))
              }, 5_000)
              timeout.unref()
            })
          ])
        } finally {
          clearTimeout(timeout)
        }
      }
      if (!this.connected) throw new Error('Could not connect')
      await this.channel.sendNotification(request)
      this.peering.stats.notificationsTx++
    } finally {
      this.pendingNotifications--
    }
  }

  destroy() {
    this.destroyed = true
    for (const info of this._pendingFlushes.values()) info.cleanup()
    this.backoff.destroy()
    if (this.channel) this.channel.close()
    if (this.socket) this.socket.destroy()
  }
}

module.exports = BlindPeering

function addWriterCores(batch, auto, maxBatchMin, maxBatchMax) {
  addCore(batch, auto.local.key, auto.local.length)

  const overflow = []
  const priorityOverflow = []
  for (const writer of auto.activeWriters) {
    // remoteContiguousLength === 0 means no peer we ever met acknowledged they have the first block
    if (
      isStaticCore(writer.core) ||
      writer.core.remoteContiguousLength === 0 ||
      batch.cores.length < maxBatchMin
    ) {
      addCore(batch, writer.core.key, writer.core.length)
    } else {
      // No peer we ever met acknowledged they have all blocks (meaning blind peer needs to download it)
      if (writer.core.length > writer.core.remoteContiguousLength) {
        priorityOverflow.push(writer.core)
      } else {
        overflow.push(writer.core)
      }
    }
  }

  for (let i = 0; i < priorityOverflow.length && batch.cores.length < maxBatchMax; i++) {
    const next = i + Math.floor(Math.random() * (priorityOverflow.length - i))
    const core = priorityOverflow[next]
    addCore(batch, core.key, core.length)
    priorityOverflow[next] = priorityOverflow[i]
  }

  for (let i = 0; i < overflow.length && batch.cores.length < maxBatchMax; i++) {
    const next = i + Math.floor(Math.random() * (overflow.length - i))
    const core = overflow[next]
    addCore(batch, core.key, core.length)
    overflow[next] = overflow[i]
  }
}

function addViewCores(batch, auto, maxBatchMax, additionalViews) {
  for (const view of auto.views()) {
    addCore(batch, view.key, view.signedLength)
  }

  for (let i = 0; i < additionalViews.length && batch.length < maxBatchMax; i++) {
    const view = additionalViews[i]
    addCore(batch, view.key, view.signedLength)
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

function decodeKey(keyToEncodedKey, encodedKey) {
  // Ensure its a buffer
  encodedKey = b4a.isBuffer(encodedKey) ? encodedKey : ID.decode(encodedKey)

  const { key } = HyperDHTAddress.decode(encodedKey)
  keyToEncodedKey.set(key, encodedKey)
  return keyToEncodedKey
}

function getKeysMap(encodedKeys) {
  return encodedKeys.reduce(decodeKey, new Map())
}
