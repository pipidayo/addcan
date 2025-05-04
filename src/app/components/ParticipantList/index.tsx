// src/app/components/ParticipantList/index.tsx
import React, { useRef, useEffect, useState, useCallback } from 'react'
import { FiMicOff, FiMonitor } from 'react-icons/fi'
import type { Participant } from '../../type'
import styles from './styles.module.css'

type ParticipantListProps = {
  participants: Participant[]
  myPeerId: string // 自分の Peer ID
  screenSharingPeerId: string | null // 現在画面共有中の人の Peer ID

  selectedSpeakerId: string // 選択中のスピーカーデバイスID
}

export default function ParticipantList({
  participants,
  myPeerId,
  screenSharingPeerId,

  selectedSpeakerId,
}: ParticipantListProps) {
  const audioRefs = useRef<{ [id: string]: HTMLAudioElement }>({})
  const selectedSpeakerIdRef = useRef(selectedSpeakerId)

  //  participantVolumes State を内部で持つ
  const [participantVolumes, setParticipantVolumes] = useState<{
    [id: string]: number
  }>({})

  //  handleVolumeChange を内部で定義
  const handleVolumeChange = useCallback((peerId: string, volume: number) => {
    setParticipantVolumes((prev) => ({ ...prev, [peerId]: volume }))
    // ★ 音量を Audio 要素にも即時反映
    if (audioRefs.current[peerId]) {
      audioRefs.current[peerId].volume = volume
    }
  }, [])

  // Props が変更されたら Ref も更新
  useEffect(() => {
    selectedSpeakerIdRef.current = selectedSpeakerId
    // ★ 既存の Audio 要素の SinkID も更新
    Object.values(audioRefs.current).forEach((audioEl) => {
      if (audioEl && typeof audioEl.setSinkId === 'function') {
        audioEl
          .setSinkId(selectedSpeakerId)
          .catch((err) =>
            console.error('Failed to set sinkId on speaker change:', err)
          )
      }
    })
  }, [selectedSpeakerId])

  //  participantVolumes 初期化 Effect を内部で持つ
  useEffect(() => {
    setParticipantVolumes((prevVolumes) => {
      const newVolumes = { ...prevVolumes }
      let changed = false
      participants.forEach((p) => {
        // 自分以外の参加者で、まだ音量設定がない場合、デフォルト値(1.0)を設定
        if (!p.isSelf && !(p.id in newVolumes)) {
          newVolumes[p.id] = 1.0
          changed = true
        }
      })
      // 変更があった場合のみ State を更新
      return changed ? newVolumes : prevVolumes
    })
  }, [participants]) // participants が変更されたら実行

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
              onChange={(e) =>
                handleVolumeChange(p.id, parseFloat(e.target.value))
              }
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
                  target.volume = participantVolumes[p.id] ?? 1.0
                }}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}
