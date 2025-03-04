const HypercoreId = require('hypercore-id-encoding')
const ProtomuxRpcClient = require('protomux-rpc-client')

const {
  CoreRecord,
  MailboxRecord
} = require('./messages.js')

module.exports = class BlindMirror extends ProtomuxRpcClient {
  async addCore (id, opts = {}) {
    const key = HypercoreId.decode(id)
    const referrer = opts.referrer ? HypercoreId.decode(opts.referrer) : null
    const autobase = opts.autobase || null
    const priority = opts.priority || 0

    await this._makeRequest(
      'add-core',
      {
        key,
        referrer,
        autobase: autobase
          ? {
              key: autobase.key,
              blockEncryptionKey: autobase.blockEncryptionKey || null
            }
          : null,
        priority
      },
      { requestEncoding: CoreRecord, responseEncoding: c.none }
    )
  }

  async postToMailbox (msg) {
    await this._makeRequest(
      'post-to-mailbox',
      msg,
      { requestEncoding: MailboxRecord, responseEncoding: c.none }
    )
  }
}
