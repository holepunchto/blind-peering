const BlindMirrorClient = require('@holepunchto/blind-mirror/client')
const xorDistance = require('xor-distance')
const b4a = require('b4a')

module.exports = class BlindMirroring {
  constructor (swarm, store, { mirrors = [], mediaMirrors = [], autobaseMirrors = mirrors, coreMirrors = mediaMirrors }) {
    this.swarm = swarm
    this.store = store
    this.autobaseMirrors = autobaseMirrors
    this.coreMirrors = coreMirrors
    this.blindMirrorsByKey = new Map()
    this.suspended = false
    this.pendingGC = new Set()
    this.gcInterval = null
    this.closed = false
  }

  suspend () {
    this.suspended = true
    this._stopGC()

    const suspending = []
    for (const ref of this.blindMirrorsByKey.values()) {
      suspending.push(ref.mirror.suspend())
    }
    return Promise.all(suspending)
  }

  resume () {
    this.suspended = false
    if (this.pendingGC.size) this._startGC()

    const resuming = []
    for (const ref of this.blindMirrorsByKey.values()) {
      resuming.push(ref.mirror.resume())
    }
    return Promise.all(resuming)
  }

  close () {
    this.closed = true
    this._stopGC()

    const pending = []
    for (const ref of this.blindMirrorsByKey.values()) {
      pending.push(ref.mirror.close())
    }
    return pending
  }

  addCoreBackground (core) {
    if (core.closing || this.closed || !this.coreMirrors.length) return
  }

  addAutobaseBackground (base) {
    if (base.closing || this.closed || !this.autobaseMirrors.length) return

    const mirrorKey = getClosestMirror(base.key, this.mirrors)
    const ref = this._getMirror(mirrorKey)

    this._mirrorBaseBackground(ref, base)

    base.core.on('migrate', () => {
      this._mirrorBaseBackground(ref, base)
    })

    base.on('close', () => {
      this._releaseMirror(ref)
    })
  }

  async _mirrorBaseBackground (ref, base) {
    ref.refs++

    try {
      await base.ready()

      await ref.mirror.add(base.local.id, {
        referrer: base.key,
        autobase: {
          // the system core is blinded as well, but we share the block key to the mirror can warmup the clock
          // this is a feature, as we let the mirror know related cores - thats it
          key: base.core.key,
          blockEncryptionKey: base.core.encryption.blockKey
        }
      })
    } catch {
      // ignore
    }

    this._releaseMirror(ref)
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
    if (!this.gcInterval) {
      this.gcInterval = setInterval(this._gc.bind(this), 2000)
    }
  }

  _gc () {
    const close = []
    for (const ref of this.pendingGC) {
      ref.gc++
      // 10 strikes is ~8-10s of inactivity
      if (ref.gc >= 10) close.push(ref)
    }

    for (const ref of close) {
      ref.mirror.close().catch(noop)
      this.pendingGC.delete(ref)
    }
  }

  _getMirror (mirrorKey) {
    const id = b4a.toString(mirrorKey, 'hex')

    let ref = this.blindMirrorsByKey.get(id)

    if (!ref) {
      const mirror = new BlindMirrorClient(mirrorKey, { dht: this.swarm.dht, suspended: this.suspended })
      mirror.on('stream', stream => this.store.replicate(stream))
      ref = { refs: 0, gc: 0, mirror }
      this.blindMirrorsByKey.set(id, ref)
    }

    if (ref.gc) this.pendingGC.delete(ref)

    ref.refs++
    ref.gc = 0

    return ref
  }
}

function getClosestMirror (key, list) {
  if (!list || !list.length) return []

  let result = null
  let current = null

  for (let i = 0; i < list.length; i++) {
    const next = xorDistance(list[i], key)
    if (current && xorDistance.gt(next, current)) continue
    current = next
    result = key
  }

  return result
}

function noop () {}
