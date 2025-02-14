const c = require('compact-encoding')

const CoreRecord = {
  preencode (state, v) {
    state.end++ // flag
    c.fixed32.preencode(state, v.key)

    if (v.referrer) c.fixed32.preencode(state, v.referrer)

    if (v.autobase) {
      c.fixed32.preencode(state, v.autobase.key)
      if (v.autobase.blockEncryptionKey) c.fixed32.preencode(state, v.autobase.blockEncryptionKey)
    }
  },
  encode (state, v) {
    const flags = ((v.referrer) ? 1 : 0) | (v.autobase ? 2 : 0) | (v.autobase && v.autobase.blockEncryptionKey ? 4 : 0)

    c.uint.encode(state, flags)
    c.fixed32.encode(state, v.key)

    if (v.referrer) c.fixed32.encode(state, v.referrer)

    if (v.autobase) {
      c.fixed32.encode(state, v.autobase.key)
      if (v.autobase.blockEncryptionKey) c.fixed32.encode(state, v.autobase.blockEncryptionKey)
    }
  },
  decode (state) {
    const flags = c.uint.decode(state)

    return {
      key: c.fixed32.decode(state),
      referrer: flags & 1 ? c.fixed32.decode(state) : null,
      autobase: flags & 2
        ? {
            key: c.fixed32.decode(state),
            blockEncryptionKey: flags & 4 ? c.fixed32.decode(state) : null
          }
        : null
    }
  }
}

module.exports = {
  CoreRecord
}
