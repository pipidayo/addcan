// src/app/components/ParticipantList/index.tsx
import React, { useRef, useEffect } from 'react'
import { FiMicOff, FiMonitor } from 'react-icons/fi'
import type { Participant } from '../CallScreen' // 型定義をインポート
import styles from './styles.module.css'

interface ParticipantListProps {
  participants: Participant[]
  myPeerId: string // 自分の Peer ID
  screenSharingPeerId: string | null // 現在画面共有中の人の Peer ID
  participantVolumes: { [id: string]: number } // 各参加者の音量
  onVolumeChange: (peerId: string, volume: number) => void // 音量変更時のコールバック
  selectedSpeakerId: string // 選択中のスピーカーデバイスID
}

export default function ParticipantList({
  participants,
  myPeerId,
  screenSharingPeerId,
  participantVolumes,
  onVolumeChange,
  selectedSpeakerId,
}: ParticipantListProps) {
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const selectedSpeakerIdRef = useRef(selectedSpeakerId)
  const participantVolumesRef = useRef(participantVolumes)

  // Props が変更されたら Ref も更新
  useEffect(() => {
    selectedSpeakerIdRef.current = selectedSpeakerId
  }, [selectedSpeakerId])

  useEffect(() => {
    participantVolumesRef.current = participantVolumes
  }, [participantVolumes])

  return (
    <ul className={styles.participantList}>
      {participants.map((p) => {
        // --- 自分自身の表示 ---
        if (p.isSelf) {
          // isSelf フラグで判定 (myPeerId との比較は不要)
          return (
            <li
              key={p.id}
              className={`${styles.participantItem} ${styles.selfParticipant} ${
                p.isSpeaking ? styles.speakingParticipant : ''
              } ${p.isMuted ? styles.mutedEffect : ''}`}
            >
              <div className={styles.participantInfo}>
                <span className={styles.participantName}>{p.name}</span>
                {/* 自分が共有中かどうかの判定 */}
                {p.id === screenSharingPeerId && (
                  <FiMonitor
                    className={styles.screenShareIndicatorIcon}
                    title='画面共有中'
                  />
                )}
              </div>
              {p.isMuted && <FiMicOff className={styles.muteIndicatorIcon} />}
            </li>
          )
        }

        // --- 他の参加者の表示 ---
        const currentVolume = participantVolumes[p.id] ?? 1.0
        return (
          <li
            key={p.id}
            className={`${styles.participantItem} ${
              p.isSpeaking ? styles.speakingParticipant : ''
            } ${p.isMuted ? styles.mutedEffect : ''}`}
          >
            <div className={styles.participantInfo}>
              <span className={styles.participantName}>{p.name}</span>
              {p.id === screenSharingPeerId && (
                <FiMonitor
                  className={styles.screenShareIndicatorIcon}
                  title='画面共有中'
                />
              )}
            </div>
            <input
              type='range'
              min='0'
              max='1'
              step='0.01'
              value={currentVolume}
              onChange={(e) => onVolumeChange(p.id, parseFloat(e.target.value))}
              className={styles.volumeSlider}
              title={`音量: ${Math.round(currentVolume * 100)}%`}
            />
            {p.isMuted && <FiMicOff className={styles.muteIndicatorIcon} />}
            {/* ★ Audio 要素 */}
            {p.stream && (
              <audio
                ref={(el) => {
                  if (el) {
                    audioRefs.current[p.id] = el
                    const newSrcObject = p.stream ?? null
                    if (el.srcObject !== newSrcObject) {
                      console.log(
                        `[ParticipantList] Setting/Clearing srcObject for audio element ${p.id}`
                      )
                      el.srcObject = newSrcObject
                    }
                  } else {
                    delete audioRefs.current[p.id]
                  }
                }}
                autoPlay
                playsInline
                muted={false}
                onLoadedMetadata={(e) => {
                  const target = e.target as HTMLAudioElement
                  if (typeof target.setSinkId === 'function') {
                    target
                      .setSinkId(selectedSpeakerIdRef.current) // Ref を使う
                      .catch((err) =>
                        console.error(
                          'Failed to set sinkId on audio element:',
                          err
                        )
                      )
                  }
                  target.volume = participantVolumesRef.current[p.id] ?? 1.0 // Ref を使う
                }}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
