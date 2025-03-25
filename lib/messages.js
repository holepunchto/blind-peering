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

module.exports = {
  MailboxRecord
}
