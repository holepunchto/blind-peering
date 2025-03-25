const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const ProtomuxRpcClient = require('protomux-rpc-client')
const {
  AddCoreEncoding,
  PostToMailboxEncoding
} = require('blind-peer-encodings')

const { PostToMailboxEncoding } = require('./messages.js')

module.exports = class BlindMirror extends ProtomuxRpcClient {
  async addCore (id, opts = {}) {
    const key = HypercoreId.decode(id)
    const referrer = opts.referrer ? HypercoreId.decode(opts.referrer) : null
    const autobase = opts.autobase || null
    const priority = opts.priority || 0
    const announce = opts.announce === true

    await this._makeRequest(
      'add-core',
      {
        key,
        referrer,
        deprecatedAutobase: autobase?.key || null,
        deprecatedAutobaseBlockKey: autobase?.blockEncryptionKey || null,
        priority,
        announce
      },
      AddCoreEncoding
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
