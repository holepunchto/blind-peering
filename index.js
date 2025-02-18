const xorDistance = require('xor-distance')
const b4a = require('b4a')
const BlindPeerClient = require('./lib/client.js')
const HypercoreId = require('hypercore-id-encoding')

module.exports = class BlindMirroring {
  constructor (swarm, store, { mirrors = [], mediaMirrors = [], autobaseMirrors = mirrors, coreMirrors = mediaMirrors }) {
    this.swarm = swarm
    this.store = store
    this.autobaseMirrors = autobaseMirrors.map(HypercoreId.decode)
    this.coreMirrors = coreMirrors.map(HypercoreId.decode)
    this.blindPeersByKey = new Map()
    this.suspended = false
    this.pendingGC = new Set()
    this.mirroring = new Set()
    this.gcInterval = null
    this.closed = false
  }

  suspend () {
    this.suspended = true
    this._stopGC()

    const suspending = []
    for (const ref of this.blindPeersByKey.values()) {
      suspending.push(ref.peer.suspend())
    }
    return Promise.all(suspending)
  }

  resume () {
    this.suspended = false
    if (this.pendingGC.size) this._startGC()

    const resuming = []
    for (const ref of this.blindPeersByKey.values()) {
      resuming.push(ref.peer.resume())
    }
    return Promise.all(resuming)
  }

  close () {
    this.closed = true
    this._stopGC()

    const pending = []
    for (const ref of this.blindPeersByKey.values()) {
      pending.push(ref.peer.close())
    }
    return Promise.all(pending)
  }

  addCoreBackground (core, target = core.key) {
    if (core.closing || this.closed || !this.coreMirrors.length) return
    if (this.mirroring.has(core)) return

    this._startCoreMirroring(core, target)
  }

  async _startCoreMirroring (core, target) {
    this.mirroring.add(core)

    try {
      await core.ready()
    } catch {}

    if (!core.opened || core.closing || this.closed) {
      this.mirroring.delete(core)
      return
    }

    const mirrorKey = getClosestMirror(target || core.key, this.coreMirrors)
    const ref = this._getBlindPeer(mirrorKey)

    core.on('close', () => {
      this.mirroring.delete(core)
      this._releaseMirror(ref)
    })

    ref.refs++

    try {
      await ref.peer.addCore(core.key)
    } catch {
      // ignore
    }

    this._releaseMirror(ref)
  }

  addAutobaseBackground (base) {
    if (base.closing || this.closed || !this.autobaseMirrors.length) return
    if (this.mirroring.has(base)) return

    this._startAutobaseMirroring(base)
  }

  async _startAutobaseMirroring (base) {
    this.mirroring.add(base)

    try {
      await base.ready()
    } catch {}

    if (!base.opened || base.closing || this.closed) {
      this.mirroring.delete(base)
    }

    const mirrorKey = getClosestMirror(base.key, this.autobaseMirrors)
    const ref = this._getBlindPeer(mirrorKey)

    this._mirrorBaseBackground(ref, base)

    base.core.on('migrate', () => {
      this._mirrorBaseBackground(ref, base)
    })

    base.on('close', () => {
      this.mirroring.delete(base)
      this._releaseMirror(ref)
    })
  }

  async _mirrorBaseBackground (ref, base) {
    ref.refs++

    try {
      await base.ready()
      if (base.closing) return

      const promises = []
      promises.push(ref.peer.addCore(base.local.key, { referrer: base.key, priority: 1 }))
      for (const view of base.system.views) {
        promises.push(ref.peer.addCore(view.key, { referrer: base.key, priority: 1 }))
      }

      await Promise.all(promises)
    } catch {
      // ignore
    }

    this._releaseMirror(ref)
  }

  postToMailboxBackground (publicKey, msg) {
    this.postToMailbox(publicKey, msg).catch(noop)
  }

  async postToMailbox (publicKey, msg) {
    const ref = this._getBlindPeer(publicKey)

    try {
      await ref.peer.postToMailbox(msg)
    } finally {
      this._releaseMirror(ref)
    }
  }

  _releaseMirror (ref) {
    if (--ref.refs) return
    ref.gc++
    this.pendingGC.add(ref)
    this._startGC()
  }

  _stopGC () {
    if (this.gcInterval) clearInterval(this.gcInterval)
    this.gcInterval = null
  }

  _startGC () {
    if (this.closed) return
    if (!this.gcInterval) {
      this.gcInterval = setInterval(this._gc.bind(this), 2000)
    }
  }

  _gc () {
    const close = []
    for (const ref of this.pendingGC) {
      const uploaded = getBlocksUploadedTo(ref.peer.stream)
      if (uploaded !== ref.uploaded) {
        ref.uploaded = uploaded
        ref.gc = ref.gc < 2 ? 1 : ref.gc - 1
        continue
      }
      ref.gc++
      // 10 strikes is ~4-8s of inactivity
      if (ref.gc >= 4) close.push(ref)
    }

    for (const ref of close) {
      ref.peer.close().catch(noop)
      this.pendingGC.delete(ref)
    }
  }

  _getBlindPeer (mirrorKey) {
    const id = b4a.toString(mirrorKey, 'hex')

    let ref = this.blindPeersByKey.get(id)

    if (!ref) {
      const peer = new BlindPeerClient(mirrorKey, { dht: this.swarm.dht, suspended: this.suspended })
      peer.on('stream', stream => this.store.replicate(stream))
      ref = { refs: 0, gc: 0, uploaded: 0, peer }
      this.blindPeersByKey.set(id, ref)
    }

    if (ref.gc) this.pendingGC.delete(ref)

    ref.refs++
    ref.gc = 0

    return ref
  }
}

function getBlocksUploadedTo (stream) {
  if (!stream || !stream.userData) return 0
  let uploadedTotal = 0
  for (const ch of stream.userData) {
    if (!ch || !ch.userData || !ch.userData.wireData) continue
    uploadedTotal += ch.userData.stats.wireData.tx
  }
  return uploadedTotal
}

function getClosestMirror (key, list) {
  if (!list || !list.length) return []

  let result = null
  let current = null

  for (let i = 0; i < list.length; i++) {
    const next = xorDistance(list[i], key)
    if (current && xorDistance.gt(next, current)) continue
    current = next
    result = list[i]
  }

  return result
}

function noop () {}
