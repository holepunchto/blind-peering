module.exports = function waitForRPC (client) {
  return new Promise((resolve, reject) => {
    client.on('open', onopen)
    client.on('destroy', ondestroy)

    function onopen (handshake) {
      removeListener()
      resolve(handshake)
    }

    function ondestroy () {
      removeListener()
      reject(new Error('Client could not connect'))
    }

    function removeListener () {
      client.off('open', onopen)
      client.off('destroy', ondestroy)
    }
  })
}
