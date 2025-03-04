const c = require('compact-encoding')
const HypercoreId = require('hypercore-id-encoding')
const safetyCatch = require('safety-catch')
const ProtomuxRpcClient = require('protomux-rpc-client')

const {
  CoreRecord,
  MailboxRecord
} = require('./messages.js')

module.exports = class BlindMirror extends ProtomuxRpcClient {
  constructor (serverKey, opts = {}) {
    super()

    this.serverKey = HypercoreId.decode(serverKey)

    this._autoDestroy = !opts.dht
    this._suspendedResolve = null

    this.ready().catch(safetyCatch)
  }

  async _close () {
    await super._close()
    if (this._autoDestroy) await this._dht.destroy()
  }

  async connect () {
    if (this._connecting) return this._connecting

    this._connecting = this._connect()

    try {
      await this._connecting
    } finally {
      this._connecting = null
    }
  }

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
