import Peer, { DataConnection } from 'peerjs'

let peer: Peer | null = null
let localStream: MediaStream | null = null
const connections: MediaConnection[] = []
const dataConnections:{[id:string]:DataConnection} = {}

type Options = {
  onReceiveStream: (stream: MediaStream) => void
  onPeerOpen: (id: string) => void
}

let currentRoomCode = ''

export const initPeer = async ({roomCode, onReceiveStream, onPeerOpen,onLocalStream,onReciveMuteStatus,onReceiveUserName }: Options) =>( {
	
	  roomCode,
	  onReceiveStream,
	  onPeerOpen,
    onLocalStream,
    onReciveMuteStatus,
    onReceiveUserName,

	}: {
	  roomCode: string;
	  onReceiveStream: (stream: MediaStream) => void;
	  onPeerOpen: (id: string) => void;
    onLocalStream: (stream: MediaStream) => void;
    onReciveMuteStatus?:(peerId:string,isMuted:boolean) => void
    onReceiveUserName?:(peerId:string,name:string) => void
	}) => {
	  currentRoomCode = roomCode
  
  }

  return new Promise<string>(async (resolve, reject) => {
    try {
      peer = new Peer()

      peer.on('open', (id) => {
        onPeerOpen(id)
        resolve(id)
      })



      peer.on('call', async (call) => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        })
        localStream = stream

        onLocalStream(stream)

        call.answer(stream)

        call.on('stream', (remoteStream) => {
          onReceiveStream(remoteStream)
        })

        connections.push(call)
      })
    } catch (err) {
      reject(err)
    }
peer?.on("connection", (conn) => {
  dataConnections[conn.peer] = conn
  
  conn.on("data", (data) => {
  if (data.type === "mute-status"){
    onReciveMuteStatus?.(conn.peer,data.isMuted)
  }else if (data.type === "user-name"){
    onReceiveUserName?.(conn.peer,data.name)
  }
  }  )

  

  })
}

export const callPeer = async (
  targetId: string,
  onReceiveStream: (stream: MediaStream) => void
) => {
  if (!peer) return

  if (!localStream) {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  }

  const call = peer.call(targetId, localStream!)
  call.on('stream', onReceiveStream)

  call.on('close', () => {
    console.log('通話切断', targetId)
    removePeerId(currentRoomCode, targetId)
  })

  connections.push(call)
}

export const disconnectAll = () => {
  connections.forEach((conn) => conn.close())
  connections.length = 0

  if (peer) {
    peer.destroy()
    peer = null
  }
}

export const removePeerId = (roomCode: string, peerId: string) => {
  const key = `peers_${roomCode}`
  const peers: string[] = JSON.parse(localStorage.getItem(key) || '[]')
  const newPeers = peers.filter((id) => id !== peerId)
  localStorage.setItem(key, JSON.stringify(newPeers))
}

export const sendUserName = (name: string) => {
  Object.values(dataConnections).forEach((conn) => {
    conn.send({
      type: "user-name",
      name,
    })
    })
}


  