'use client'
import { useEffect, useState } from 'react'
import Peer from 'peerjs'
import styles from './styles.module.css'

type Props = {
  roomCode: string
}

export default function VoiceChat({ roomCode }: Props) {
  const [peer, setPeer] = useState<Peer | null>(null)
  const [connections, setConnections] = useState<Peer.DataConnection[]>([])
  const [myId, setMyId] = useState<string | null>(null)
  const [peersInRoom, setPeersInRoom] = useState<string[]>([])

  useEffect(() => {
    const newPeer = new Peer()
    setPeer(newPeer)

    newPeer.on('open', (id) => {
      setMyId(id)
      joinRoom(id)
    })

    newPeer.on('connection', (conn) => {
      conn.on('data', (data) => {
        if (typeof data === 'string') {
          setPeersInRoom((prev) => [...new Set([...prev, data])])
        }
      })

      setConnections((prev) => [...prev, conn])
    })

    return () => newPeer.destroy()
  }, [])

  const joinRoom = (id: string) => {
    // サーバーのURL
    fetch(`https://your-server.com/api/join-room?room=${roomCode}&peerId=${id}`)
  }

  useEffect(() => {
    if (peer) {
      fetch(`https://your-server.com/api/get-peers?room=${roomCode}`)
        .then((res) => res.json())
        .then((peerIds: string[]) => {
          peerIds.forEach((peerId) => {
            if (peerId !== myId) {
              const conn = peer.connect(peerId)
              conn.on('open', () => {
                conn.send(myId)
              })
              setConnections((prev) => [...prev, conn])
            }
          })
        })
    }
  }, [peer])

  return (
    <div>
      <h3>通話中:{peersInRoom.length}人</h3>
      <ul>
        {peersInRoom.map((id) => (
          <li key={id}>{id}</li>
        ))}
      </ul>
    </div>
  )
}
