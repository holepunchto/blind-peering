const Hyperschema = require('hyperschema')

const schema = Hyperschema.from('./spec/hyperschema')
const ns = schema.namespace('blind-peering')

ns.register({
  name: 'blind-peer-key',
  fields: [
    {
      name: 'key',
      type: 'fixed32',
      required: true
    },
    {
      name: 'nodes',
      type: 'ipv4Address',
      array: true
    }
  ]
})

Hyperschema.toDisk(schema)
