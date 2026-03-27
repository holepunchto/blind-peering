const Hyperswarm = require('hyperswarm')
const IdEnc = require('hypercore-id-encoding')
const Corestore = require('corestore')

const bps = [
  '4c39n36w8ho48qtuqcguu8pwubu6ohxr4wq1jxqj7drhq4j3edho',
  'ep4bxqnksbeikpjc99kibih314f33ox64318gogz7c5ra4pecqqy',
  'naraymtsa7ob85bchpazs76dqqefscuiqo6cdxwqyku7gbf93ipy',
  'jer19u85dibjcdabhcrt1gehzrtux4caos5p5aqjfjpw3ayqnkry',
  '11acfj3mo8x3prq348e8fuuihbhuakbe55xstybk4aktur6dgado',
  '78xqipa6khjzbwufj38ijom8m89gz7uc9xoo93iw3iioap1cys3o',
  '133tphu316kggjpq3hoakmg4cmjrbkg14e1xznijqgbdd6ydshiy',
  'ui47euoy6u5g8aaxd49x5d6goe1gi69uaz39ug9hzy5ps6g67zxy',
  'a89erh4bmm31ig1tn45cmgruf7smin5j9q11pk93eqdndbcx9wwy',
  'qp4qtzgfeom9yuyurc9p5j5y8gmmjefggzrbu5gzxewpjp8o5kqy',
  '7bzpaaj7oxpd5fraupngyjnq1abrjiada5z57ig38f3n6rbdunry',
  'czgrdix4yj3t6a3rbbhihr6rpna3c8xe5ebrww8ikragkykoixky',
  'fowxs6xwemxt7axwy4o1rabyu7euybcnt1chqn6xq8gjmo341p6y',
  '38dkq3yj1jx3p6985g1cga3jqzfbm9rn74cwgbnm61frumsy4ano',
  'zqggztda96prn1qgo5pd3ttbkmgrtyag69nh9g8esz8y3boaz3oy'
]

const cores = [
  'b87iwqu43k45pjqdhcjj4dmhr7agyjfnoa1z5q4wurtottowpcxo',
  'osmkt365y4d43ncn4z5r49jq3quewiwmx8q1zfwuhjuqz6jdtyty'
]

async function main() {
  const store = new Corestore('qt-storage')
  await store.ready()

  // We need a consistent keypair across restarts, because we use
  // an allow-list at the blind-peer side (to which our key should be added)
  const swarm = new Hyperswarm()
  swarm.on('connection', (conn, peerInfo) => {
    const key = IdEnc.normalize(peerInfo.publicKey)
    console.info(`Opened connection to ${key}`)
    conn.on('close', () => console.debug(`Closed connection to ${key}`))

    store.replicate(conn)
  })
  for (const key of cores) {
    const core = store.get(IdEnc.decode(key))
    await core.ready()
    core.download({ start: 0, end: -1 })
    setInterval(() => {
      console.log(
        `Core ${key}: ${core.peers.length} peers. Contig length: ${core.contiguousLength}/${core.length}`
      )
    }, 10000)
  }

  console.log('joining all blind peers')
  for (const bp of bps) swarm.joinPeer(IdEnc.decode(bp))
}

main()
