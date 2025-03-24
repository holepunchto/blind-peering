const c = require('compact-encoding')

const MailboxRecord = {
  preencode (state, v) {
    c.buffer.preencode(state, v.mailbox)
    c.buffer.preencode(state, v.message)
  },
  encode (state, v) {
    c.buffer.encode(state, v.mailbox)
    c.buffer.encode(state, v.message)
  },
  decode (state) {
    return {
      mailbox: c.buffer.decode(state),
      message: c.buffer.decode(state)
    }
  }
}

const CoreRecord = {
  preencode (state, v) {
    state.end++ // flag
    c.fixed32.preencode(state, v.key)

    if (v.referrer) c.fixed32.preencode(state, v.referrer)

    if (v.autobase) {
      c.fixed32.preencode(state, v.autobase.key)
      if (v.autobase.blockEncryptionKey) c.fixed32.preencode(state, v.autobase.blockEncryptionKey)
    }

    if (v.priority) {
      c.uint.preencode(state, v.priority)
    }
    if (v.announce) {
      c.bool.preencode(state, v.announce)
    }
  },
  encode (state, v) {
    const flags = ((v.referrer) ? 1 : 0) | (v.autobase ? 2 : 0) | (v.autobase && v.autobase.blockEncryptionKey ? 4 : 0) | (v.priority ? 8 : 0) | (v.announce ? 16 : 0)

    c.uint.encode(state, flags)
    c.fixed32.encode(state, v.key)

    if (v.referrer) c.fixed32.encode(state, v.referrer)

    if (v.autobase) {
      c.fixed32.encode(state, v.autobase.key)
      if (v.autobase.blockEncryptionKey) c.fixed32.encode(state, v.autobase.blockEncryptionKey)
    }

    if (v.priority) {
      c.uint.encode(state, v.priority)
    }
    if (v.announce) {
      c.bool.encode(state, v.announce)
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
        : null,
      priority: flags & 8 ? c.uint.decode(state) : 0,
      announce: flags & 16 ? c.bool.decode(state) : false
    }
  }
}

module.exports = {
  MailboxRecord,
  CoreRecord
}
