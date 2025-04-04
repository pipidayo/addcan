'use client'
import styles from './styles.module.css'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState, useRef } from 'react'
import { initPeer, callPeer, disconnectAll } from '../PeerManager'
import { on } from 'events'

export default function CallScreen() {
  const { roomCode } = useParams()
  const router = useRouter()

  const [myPeerId, setMyPeerId] = useState('')
  const [participants, setParticipantis] = useState<string[]>([])
  const [myName, setMyName] = useState('')
  const audioRefs = useRef<HTMLAudioElement[]>([])
  const connectedIds = useRef<string[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const localstreamRef = useRef<MediaStream | null>(null)

  const toggleMic = () => {
    if (!localstreamRef.current) return

    const audioTrack = localstreamRef.current.getAudioTracks()[0]
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled
      setIsMuted(!audioTrack.enabled)
    }
  }

  useEffect(() => {
    const name = localStorage.getItem('my_name')
    if (name) {
      setMyName(name)
    }

    const roomData = localStorage.getItem(`room_${roomCode}`)
    if (roomData) {
      const room = JSON.parse(roomData)
      setParticipantis(room.participants)
    } else {
      alert('部屋が存在しません')
      router.push('/')
    }

    initPeer({
      roomCode: roomCode,
      onReceiveStream: (stream) => {
        const audio = new Audio()
        audio.srcObject = stream
        audio.play()
        audioRefs.current.push(audio)
      },
      onPeerOpen: (Id) => {
        setMyPeerId(Id)

        const peerList = JSON.parse(
          localStorage.getItem(`peers_${roomCode}`) || '[]'
        )
        if (!peerList.includes(Id)) {
          peerList.push(Id)
          localStorage.setItem(`peers_${roomCode}`, JSON.stringify(peerList))
        }
        onLocalStream: stream
        localstreamRef.current = stream
      },
    })
  }, [roomCode, router])

  useEffect(() => {
    const interval = setInterval(() => {
      const peerList: string[] = JSON.parse(
        localStorage.getItem(`peers_${roomCode}`) || '[]'
      )

      peerList.forEach((id) => {
        if (id !== myPeerId && !connectedIds.current.includes(id)) {
          connectedIds.current.push(id)
          callPeer(id, (stream) => {
            const audio = new Audio()
            audio.srcObject = stream
            audio.play()
            audioRefs.current.push(audio)
          })
        }
      })
    }, 2000)

    return () => clearInterval(interval)
  }, [myPeerId, roomCode])

  const connectToOthers = async () => {
    const peerList: string[] = JSON.parse(
      localStorage.getItem(`peers_${roomCode}`) || '[]'
    )
    peerList.forEach((Id) => {
      if (Id !== myPeerId) {
        callPeer(Id, (stream) => {
          const audio = new Audio()
          audio.srcObject = stream
          audio.play()
          audioRefs.current.push(audio)
        })
      }
    })
  }

  const leaveRoom = () => {
    disconnectAll()

    const peerList: string[] = JSON.parse(
      localStorage.getItem(`peers_${roomCode}`) || '[]'
    )
    const newList = peerList.filter((Id) => Id !== myPeerId)
    localStorage.setItem(`peers_${roomCode}`, JSON.stringify(newList))

    router.push('/')
  }

  return (
    <div className={styles.container}>
      <h1>通話画面</h1>
      <p>あなたの名前:{myName}</p>
      <p>あなたのID:{myPeerId}</p>
      <button onClick={connectToOthers} className={styles.button}>
        参加者と通話開始
      </button>

      <h2>参加者リスト</h2>
      <ul>
        {participants.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
      <button onClick={toggleMic}>
        {isMuted ? '🔇 ミュート中' : '🎤 ミュート解除'}
      </button>

      <button onClick={leaveRoom} className={styles.button}>
        退出
      </button>
    </div>
  )
}
