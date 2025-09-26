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
    pick = 2,
    relayThrough = null,
    passive = false
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
    this.passive = passive
    this.pick = pick

    this.swarm.dht.on('network-change', () => {
      for (const ref of this.blindPeersByKey.values()) ref.peer.bump()
    })
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

  addCoreBackground (core, target = core.key, { announce = false, referrer = null, priority = 0, pick = this.pick, mirrors = this.coreMirrors } = {}) {
    if (core.closing || this.closed || !mirrors.length) return
    if (this.mirroring.has(core)) return

    this._startCoreMirroring(core, target, mirrors, announce, referrer, priority, pick)
  }

  async addCore (core, target = core.key, { announce = false, referrer = null, priority = 0, pick = this.pick, mirrors = this.coreMirrors } = {}) {
    if (core.closing || this.closed || !mirrors.length) return []
    if (this.mirroring.has(core)) return []

    return await this._startCoreMirroring(core, target, mirrors, announce, referrer, priority, pick)
  }

  async deleteCore (key, target = key, { pick = this.pick, mirrors = this.coreMirrors } = {}) {
    const proms = []
    const refs = []
    for (const mirrorKey of getClosestMirrorList(target, mirrors, pick)) {
      const ref = this._getBlindPeer(mirrorKey)
      proms.push(ref.peer.deleteCore(key))
      refs.push(ref)
    }

    try {
      await Promise.allSettled(proms)
      return await Promise.all(proms)
    } finally {
      for (const ref of refs) this._releaseMirror(ref)
    }
  }

  async _startCoreMirroring (core, target, mirrors, announce, referrer, priority, pick) {
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

    if (pick === 1) { // easy case
      return [await this._mirrorCore(getClosestMirror(target, mirrors), core, announce, referrer, priority)]
    }

    const all = []
    for (const mirrorKey of getClosestMirrorList(target, mirrors, pick)) {
      all.push(this._mirrorCore(mirrorKey, core, announce, referrer, priority))
    }
    return Promise.all(all)
  }

  async _mirrorCore (mirrorKey, core, announce, referrer, priority) {
    if (!mirrorKey) return

    const ref = this._getBlindPeer(mirrorKey)

    core.on('close', () => {
      if (ref.cores.get(core.id) === core) ref.cores.delete(core.id)
      this.mirroring.delete(core)
      this._releaseMirror(ref)
    })

    ref.refs++
    ref.cores.set(core.id, core)

    try {
      return this.passive ? await ref.peer.connect() : await ref.peer.addCore(core.key, { announce, referrer, priority })
    } catch (e) {
      safetyCatch(e)
      // ignore
    } finally {
      this._releaseMirror(ref)
    }
  }

  addAutobaseBackground (base, target = (base.wakeupCapability && base.wakeupCapability.key), { all = false, pick = this.pick, mirrors = this.autobaseMirrors } = {}) {
    if (base.closing || this.closed || !mirrors.length) return
    if (this.mirroring.has(base)) return

    this._startAutobaseMirroring(base, target, mirrors, all, pick)
  }

  async addAutobase (base, target = (base.wakeupCapability && base.wakeupCapability.key), { all = false, pick = this.pick, mirrors = this.autobaseMirrors } = {}) {
    if (base.closing || this.closed || !mirrors.length) return
    if (this.mirroring.has(base)) return

    return this._startAutobaseMirroring(base, target, mirrors, all, pick)
  }

  async _startAutobaseMirroring (base, target, mirrors, all, pick) {
    this.mirroring.add(base)

    try {
      await base.ready()
    } catch {
      this.mirroring.delete(base)
      return
    }

    if (!base.opened || base.closing || this.closed) {
      this.mirroring.delete(base)
      return
    }

    if (!target) target = base.wakeupCapability.key

    const closest = getClosestMirrorList(target, mirrors, pick)
    if (!closest.length) return []

    const promises = []

    for (const mirrorKey of closest) {
      const ref = this._getBlindPeer(mirrorKey)

      base.core.on('migrate', () => {
        this._mirrorBaseBackground(ref, base, all)
      })

      base.on('writer', (writer) => {
        const always = isStaticCore(writer.core) || all
        this._mirrorBaseWriterBackground(ref, base, writer.core, always)
      })

      base.on('close', () => {
        this.mirroring.delete(base)
        this._releaseMirror(ref)
      })

      promises.push(this._mirrorBaseBackground(ref, base, all))
    }

    return Promise.all(promises)
  }

  async _mirrorBaseWriter (ref, base, core, always) {
    if (ref.cores.has(core.id)) return

    ref.refs++

    try {
      if (!always && core.id !== base.local.id) {
        return
      }

      ref.cores.set(core.id, core)

      core.on('close', () => {
        if (ref.cores.get(core.id) === core) ref.cores.delete(core.id)
      })

      const referrer = base.wakeupCapability.key
      if (this.passive) {
        await ref.peer.connect()
      } else {
        await ref.peer.addCore(core.key, { announce: false, referrer, priority: 1 })
      }
    } finally {
      this._releaseMirror(ref)
    }
  }

  async _mirrorBaseWriterBackground (ref, base, core, always) {
    try {
      await this._mirrorBaseWriter(ref, base, core, always)
    } catch (e) {
      safetyCatch(e)
    }
  }

  _addBaseCores (ref, base, all) {
    if (this.passive) return Promise.all([ref.peer.connect()])

    const promises = []
    promises.push(this._mirrorBaseWriter(ref, base, base.local, true))

    for (const writer of base.activeWriters) {
      const always = isStaticCore(writer.core) || all
      promises.push(this._mirrorBaseWriter(ref, base, writer.core, always))
    }

    for (const view of base.views()) {
      promises.push(ref.peer.addCore(view.key, { announce: false, referrer: null, priority: 1 }))
    }

    return Promise.all(promises)
  }

  async _mirrorBaseBackground (ref, base, all) {
    ref.refs++

    try {
      await base.ready()
      if (base.closing) return
      await this._addBaseCores(ref, base, all)
    } catch {
      // ignore
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
      const id = b4a.toString(ref.peer.remotePublicKey, 'hex')
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

        for (const core of ref.cores.values()) {
          if (core.closing || core.closed) continue
          core.replicate(stream)
        }
      })
      ref = { refs: 0, gc: 0, uploaded: 0, peer, cores: new Map() }
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
