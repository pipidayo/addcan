'use client'
import { useState, useEffect } from 'react'
import { useRouter, useParams } from 'next/navigation'
import RoomHeader from '@/app/components/RoomHeader'
import styles from './styles.module.css'

export default function room() {
  const { roomCode } = useParams()
  const router = useRouter()
  const [participants, setParticipantis] = useState<string[]>([])

  useEffect(() => {
    setParticipantis(['a', 'b', 'c'])
  }, [])

  return (
    <div className={styles.container}>
      <RoomHeader></RoomHeader>
    </div>
  )
}
