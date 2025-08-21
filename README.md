# Blind Peering

Client for interacting with [blind peers](https://github.com/holepunchto/blind-peer), sending RPC requests to keep hypercores and autobases available.

## Installl

```
npm install blind-peering
```

## API

#### `const blindPeering = new BlindPeering(swarm, store, opts)`

Create a new Blind Peering instance. `swarm` is a hyperswarm instance and `store` is a Corestore instance.

`opts` include:
- `mirrors`: a list of blind peer keys (mirrors) to use. You should always set this, otherwise there are no mirrors to contact.
- `suspended`: whether to start in suspended state (default `false`)
- `wakeup`: a Wakeup object

#### `await blindPeering.addCore(core, target = core.key, opts)`

Add a Hypercore to a blind peer.

`target` is an optional key. If set, it looks for blind peers 'close' to that key. It defaults to the key of the hypercore, thereby load balancing among the available blind peers. To use a specific blind peer, set `target` to its key.

`opts` include:
- `announce`: whether the hypercore should be announced to the swarm (default false)
- `mirrors`: how many blind peers to contact. Defaults to 1.
- `referrer`: key of a referrer hypercore to pass to the blind peer
- `priority`: integer indicating the priority to request. See Blind Peer for the possibilities

#### `blindPeering.addCoreBackground(core, target = core.key, opts)`

Same as `addCore`, but is sync (it runs in the background).

#### `await blindPeering.addAutobase(base, target)`

Add an autobase to a blind peer.

`base` is an Autobase instance.

`target` is an optional key. If set, it looks for blind peers 'close' to that key. It defaults to the autobase's wakeupCapability key (or the autobase's key if the wakeup capability does not exist).

#### `blindPeering.addAutobaseBackground(base, target)`

Add an autobase to a blind peer (runs in the background).

`base` is an Autobase instance.

`target` is an optional key. If set, it looks for blind peers 'close' to that key. It defaults to the autobase's wakeupCapability key (or the autobase's key if the wakeup capability does not exist).

#### `await blindPeering.suspend()`

Suspend all activity.

#### `await blindPeering.resume()`

Resume activity after having been suspended.

#### `await blindPeering.close()`

Close the blind peering instance.
