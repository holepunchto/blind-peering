const xorDistance = require('xor-distance')
const b4a = require('b4a')
const HypercoreId = require('hypercore-id-encoding')
const safetyCatch = require('safety-catch')

const BlindPeerClient = require('./lib/client.js')

module.exports = class BlindPeering {
  constructor (swarm, store, {
    suspended = false,
    wakeup = null,
    mirrors = [],
    mediaMirrors = mirrors,
    autobaseMirrors = mirrors,
    coreMirrors = mediaMirrors,
    gcWait = 2000,
    relayThrough = null
  }) {
    this.swarm = swarm
    this.store = store
    this.wakeup = wakeup
    this.autobaseMirrors = autobaseMirrors.map(HypercoreId.decode)
    this.coreMirrors = coreMirrors.map(HypercoreId.decode)
    this.blindPeersByKey = new Map()
    this.suspended = suspended
    this.gcWait = gcWait
    this.pendingGC = new Set()
    this.mirroring = new Set()
    this.gcInterval = null
    this.closed = false
    this.relayThrough = relayThrough
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

  addCoreBackground (core, target = core.key, { announce = false, referrer = null, priority = 0, mirrors = 1 } = {}) {
    if (core.closing || this.closed || !this.coreMirrors.length) return
    if (this.mirroring.has(core)) return

    this._startCoreMirroring(core, target, announce, referrer, priority, mirrors)
  }

  async addCore (core, target = core.key, { announce = false, referrer = null, priority = 0, mirrors = 1 } = {}) {
    if (core.closing || this.closed || !this.coreMirrors.length) return []
    if (this.mirroring.has(core)) return []

    return await this._startCoreMirroring(core, target, announce, referrer, priority, mirrors)
  }

  async _startCoreMirroring (core, target, announce, referrer, priority, mirrors) {
    this.mirroring.add(core)

    try {
      await core.ready()
    } catch (e) {
      safetyCatch(e)
    }

    if (!core.opened || core.closing || this.closed) {
      this.mirroring.delete(core)
      return []
    }

    if (!target) target = core.key

    if (mirrors === 1) { // easy case
      return [await this._mirrorCore(getClosestMirror(target, this.coreMirrors), core, announce, referrer, priority)]
    }

    const all = []
    for (const mirrorKey of getClosestMirrorList(target, this.coreMirrors, mirrors)) {
      all.push(this._mirrorCore(mirrorKey, core, announce, referrer, priority))
    }
    return Promise.all(all)
  }

  async _mirrorCore (mirrorKey, core, announce, referrer, priority) {
    if (!mirrorKey) return

    const ref = this._getBlindPeer(mirrorKey)

    core.on('close', () => {
      this.mirroring.delete(core)
      this._releaseMirror(ref)
    })

    ref.refs++

    try {
      return await ref.peer.addCore(core.key, { announce, referrer, priority })
    } catch (e) {
      safetyCatch(e)
      // ignore
    } finally {
      this._releaseMirror(ref)
    }
  }

  addAutobaseBackground (base, target = (base.wakeupCapability && base.wakeupCapability.key), { all = false } = {}) {
    if (base.closing || this.closed || !this.autobaseMirrors.length) return
    if (this.mirroring.has(base)) return

    this._startAutobaseMirroring(base, target, all)
  }

  async addAutobase (base, target = (base.wakeupCapability && base.wakeupCapability.key), { all = false } = {}) {
    if (base.closing || this.closed || !this.autobaseMirrors.length) return
    if (this.mirroring.has(base)) return

    return this._startAutobaseMirroring(base, target, all)
  }

  async _startAutobaseMirroring (base, target, all) {
    this.mirroring.add(base)

    try {
      await base.ready()
    } catch {}

    if (!base.opened || base.closing || this.closed) {
      this.mirroring.delete(base)
    }

    if (!target) target = base.wakeupCapability.key

    const mirrorKey = getClosestMirror(target, this.autobaseMirrors)
    if (!mirrorKey) return

    const ref = this._getBlindPeer(mirrorKey)

    base.core.on('migrate', () => {
      this._mirrorBaseBackground(ref, base, all)
    })

    base.on('writer', (writer) => {
      if (!isStaticCore(writer.core) && !all) return
      this._mirrorBaseWriterBackground(ref, base, writer.core)
    })

    base.on('close', () => {
      this.mirroring.delete(base)
      this._releaseMirror(ref)
    })

    return this._mirrorBaseBackground(ref, base, all)
  }

  async _mirrorBaseWriterBackground (ref, base, core) {
    ref.refs++

    const referrer = base.wakeupCapability.key

    try {
      return await ref.peer.addCore(core.key, { announce: false, referrer, priority: 1 })
    } catch (e) {
      safetyCatch(e)
      // ignore
    } finally {
      this._releaseMirror(ref)
    }
  }

  async _mirrorBaseBackground (ref, base, all) {
    ref.refs++

    try {
      await base.ready()
      if (base.closing) return

      const referrer = base.wakeupCapability.key

      const promises = []

      promises.push(ref.peer.addCore(base.local.key, { announce: false, referrer, priority: 1 }))

      for (const writer of base.activeWriters) {
        if (!isStaticCore(writer.core) && !all) continue
        promises.push(ref.peer.addCore(writer.core.key, { announce: false, referrer, priority: 1 }))
      }

      for (const view of base.views()) {
        promises.push(ref.peer.addCore(view.key, { announce: false, referrer: null, priority: 1 }))
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
      this.gcInterval = setInterval(this._gc.bind(this), this.gcWait)
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
      const id = b4a.toString(ref.peer.serverKey, 'hex')
      this.blindPeersByKey.delete(id)
      ref.peer.close().catch(noop)
      this.pendingGC.delete(ref)
    }
  }

  _getBlindPeer (mirrorKey) {
    const id = b4a.toString(mirrorKey, 'hex')

    let ref = this.blindPeersByKey.get(id)

    if (!ref) {
      const peer = new BlindPeerClient(mirrorKey, this.swarm.dht, { suspended: this.suspended, relayThrough: this.relayThrough })
      peer.on('stream', stream => {
        this.store.replicate(stream)
        if (this.wakeup) this.wakeup.addStream(stream)
      })
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

function getClosestMirrorList (key, list, n) {
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

function getClosestMirror (key, list) {
  if (!list || !list.length) return null

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

function isStaticCore (core) {
  return !!core.manifest && core.manifest.signers.length === 0
}

function noop () {}
