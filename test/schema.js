const test = require('brittle')
const b4a = require('b4a')

const { encode, decode } = require('../spec/hyperschema')

test('key is compat', async (t) => {
  const key = b4a.alloc(32).fill('secret')
  const encoded = encode('@blind-peering/blind-peer-key', { key, nodes: [] })

  t.is(encoded.subarray(0, 32).toString('hex'), key.toString('hex'))
})

test('key with nodes is compat', async (t) => {
  const key = b4a.alloc(32).fill('secret')
  const encoded = encode('@blind-peering/blind-peer-key', {
    key,
    nodes: [{ host: '127.0.0.1', port: 30000 }]
  })

  t.is(encoded.subarray(0, 32).toString('hex'), key.toString('hex'))
})

test('can decode', async (t) => {
  const key = b4a.alloc(32).fill('secret')
  const data = {
    key,
    nodes: []
  }

  const encoded = encode('@blind-peering/blind-peer-key', data)

  t.is(
    encoded.toString('hex'),
    '73656372657473656372657473656372657473656372657473656372657473650100'
  )

  const result = decode('@blind-peering/blind-peer-key', encoded)
  t.alike(result.key, data.key)
  t.alike(result.nodes, [])
})

test('can decode with nodes', async (t) => {
  const key = b4a.alloc(32).fill('secret')
  const data = {
    key,
    nodes: [
      { host: '127.0.0.1', family: 4, port: 30000 },
      { host: '127.0.0.1', family: 4, port: 30001 },
      { host: '127.0.0.1', family: 4, port: 30002 }
    ]
  }

  const encoded = encode('@blind-peering/blind-peer-key', data)

  t.is(
    encoded.toString('hex'),
    '736563726574736563726574736563726574736563726574736563726574736501037f00000130757f00000131757f0000013275'
  )

  const result = decode('@blind-peering/blind-peer-key', encoded)
  t.alike(result.key, data.key)
  t.alike(result.nodes, data.nodes)
})

test('can decode old key', async (t) => {
  const key = b4a.alloc(32).fill('secret')

  const result = decode('@blind-peering/blind-peer-key', b4a.concat([key, b4a.alloc(1)]))
  t.alike(result.key, key)
  t.alike(result.nodes, null)
})
