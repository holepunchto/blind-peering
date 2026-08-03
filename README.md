# Blind Peering

Client for interacting with [blind peers](https://github.com/holepunchto/blind-peer), sending RPC requests to keep hypercores and autobases available.

## Installl

```
npm install blind-peering
```

## API

#### `const blindPeering = new BlindPeering(dht, store, opts)`

Create a new Blind Peering instance. `dht` is a HyperDHT instance and `store` is a Corestore instance.

`opts` include:

- `blindPeers`: a list of `{ key, group }` blind peers (mirrors) to use. You should always set this, otherwise there are no mirrors to contact. `group` is optional and indicates where the blind peer is hosted, so that mirrors for the same core are picked from different groups where possible.
- `suspended`: whether to start in suspended state (default `false`)
- `wakeup`: a Wakeup object

#### `blindPeering.setBlindPeers(blindPeers)`

Replace the list of blind peers, in the same `{ key, group }` form the constructor takes, and re-add the currently mirrored cores and autobases to the new set.

#### `await blindPeering.addCore(core, { target = core.key, ...opts })`

Add a Hypercore to a blind peer.

`target` is an optional key. It looks for blind peers 'close' (using XOR distance) to that key. It defaults to the key of the hypercore, thereby load balancing among the available blind peers. To use a specific blind peer, set `target` to its key.

`opts` include:

- `announce`: whether the hypercore should be announced to the swarm (default false)
- `mirrors`: how many blind peers to contact. Defaults to 1.
- `referrer`: key of a referrer hypercore to pass to the blind peer
- `priority`: integer indicating the priority to request. See Blind Peer for the possibilities
- `blindPeers`: use these `{ key, group }` blind peers instead of the configured ones, for a core that should live on its own set of mirrors

#### `blindPeering.addCoreBackground(core, { target = core.key, ...opts })`

Same as `addCore`, but is sync (it runs in the background).

#### `await blindPeering.sendNotification(core, { roomKey = core.key, roomDiscoveryKey, index = core.length - 1, target = core.key, ...opts })`

Ask the closest blind peer to create a `blind-push` notification for `core` and forward it to its configured push gateway.

This requires that the target blind peer already has the core or autobase attached for replication.

#### `blindPeering.sendNotificationBackground(core, opts)`

Same as `sendNotification`, but runs in the background.

#### `await blindPeering.addAutobase(base, { target, ...opts })`

Add an autobase to a blind peer.

`base` is an Autobase instance.

`target` is an optional key. It looks for blind peers 'close' (using XOR distance) to that key. It defaults to the autobase's `wakeupCapability.key`.

#### `blindPeering.addAutobaseBackground(base, { target, ...opts })`

Add an autobase to a blind peer (runs in the background).

`base` is an Autobase instance.

`target` is an optional key. It looks for blind peers 'close' (using XOR distance) to that key. It defaults to the autobase's `wakeupCapability.key`.

#### `await blindPeering.suspend()`

Suspend all activity.

#### `await blindPeering.resume()`

Resume activity after having been suspended.

#### `await blindPeering.close()`

Close the blind peering instance.
