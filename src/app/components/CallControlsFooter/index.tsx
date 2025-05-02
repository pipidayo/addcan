// src/app/components/CallControlsFooter/index.tsx
import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import styles from './styles.module.css'
import type { Participant } from '../CallScreen'
import {
  FiMic,
  FiMicOff,
  FiMonitor,
  FiSettings,
  FiPhone,
  FiCheck,
} from 'react-icons/fi'

// Props の型定義
interface CallControlsFooterProps {
  isMuted: boolean
  isScreenSharing: boolean
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
  selectedMicId: string
  selectedSpeakerId: string
  localStream: MediaStream | null
  toggleMic: () => void
  toggleScreenShare: () => void
  handleMicChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  handleSpeakerChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  leaveRoom: () => void
  myPeerId: string
  participants: Participant[]
  screenSharingPeerId: string | null
  roomCode: string | undefined
  screenVolume: number
  handleScreenVolumeChange: (volume: number) => void
  isScreenShareButtonDisabled: boolean
}

export default function CallControlsFooter({
  isMuted,
  isScreenSharing,
  microphones,
  speakers,
  selectedMicId,
  selectedSpeakerId,
  localStream,
  toggleMic,
  toggleScreenShare,
  handleMicChange,
  handleSpeakerChange,
  leaveRoom,
  screenSharingPeerId,
  myPeerId,
  participants,
  roomCode,
  screenVolume,
  handleScreenVolumeChange,
  isScreenShareButtonDisabled,
}: CallControlsFooterProps) {
  const [showDeviceSettings, setShowDeviceSettings] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const displayCode = useMemo(() => roomCode?.replace('room-', ''), [roomCode])
  const settingsPopupRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)

  const sharingParticipantName = useMemo(() => {
    if (!screenSharingPeerId) return null
    if (screenSharingPeerId === myPeerId) return 'あなた'
    return (
      participants.find((p) => p.id === screenSharingPeerId)?.name || '参加者'
    )
  }, [screenSharingPeerId, myPeerId, participants])

  // コピー処理
  const handleCopyCode = useCallback(() => {
    if (!displayCode || isCopied) return

    const textToCopy = displayCode
    navigator.clipboard
      .writeText(textToCopy)
      .then(() => {
        console.log('Text copied to clipboard:', textToCopy)
        setIsCopied(true)
        setTimeout(() => {
          setIsCopied(false)
        }, 1500)
      })
      .catch((err) => {
        console.error('Failed to copy text:', err)
        alert('テキストのコピーに失敗しました。')
      })
  }, [displayCode, isCopied])

  // ポップアップ外クリックで閉じる useEffect
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        (settingsButtonRef.current &&
          settingsButtonRef.current.contains(event.target as Node)) ||
        (settingsPopupRef.current &&
          settingsPopupRef.current.contains(event.target as Node))
      ) {
        return
      }
      setShowDeviceSettings(false)
    }

    if (showDeviceSettings) {
      document.addEventListener('mousedown', handleClickOutside)
    } else {
      document.removeEventListener('mousedown', handleClickOutside)
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showDeviceSettings])

  return (
    <div className={styles.footerContainer}>
      {/* デバイス設定ポップアップ */}
      {showDeviceSettings && (
        <div ref={settingsPopupRef} className={styles.deviceSettingsPopup}>
          <div className={styles.deviceSelector}>
            <label htmlFor='mic-select-footer'>マイク</label>
            <select
              id='mic-select-footer'
              value={selectedMicId}
              onChange={handleMicChange}
              disabled={microphones.length === 0}
            >
              {microphones.map((mic) => (
                <option key={mic.deviceId} value={mic.deviceId}>
                  {mic.label || `Microphone ${microphones.indexOf(mic) + 1}`}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.deviceSelector}>
            <label htmlFor='speaker-select-footer'>スピーカー</label>
            <select
              id='speaker-select-footer'
              value={selectedSpeakerId}
              onChange={handleSpeakerChange}
              disabled={speakers.length === 0}
            >
              {speakers.map((speaker) => (
                <option key={speaker.deviceId} value={speaker.deviceId}>
                  {speaker.label || `Speaker ${speakers.indexOf(speaker) + 1}`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* ★ 左側コントロール (部屋コード) */}
      <div className={styles.leftControls}>
        {displayCode && (
          <div className={styles.roomCodeContainerFooter}>
            <span className={styles.roomLabelFooter}>部屋コード</span>
            <div
              className={styles.roomCodeFooter}
              onClick={handleCopyCode}
              title={'クリックしてルームコードをコピー'}
            >
              <span className={styles.roomCodeValueFooter}>{displayCode}</span>
              <div
                className={`${styles.copyTooltip} ${isCopied ? styles.visible : ''}`}
              >
                <FiCheck style={{ marginRight: '4px' }} />
                コピー完了！
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ★ 中央コントロール (主要ボタン) */}
      <div className={styles.controls}>
        <button
          onClick={toggleMic}
          className={`${styles.controlButton} ${isMuted ? styles.mutedButton : ''}`}
          disabled={!localStream}
          title={isMuted ? 'ミュート解除' : 'ミュート'}
        >
          {isMuted ? <FiMicOff /> : <FiMic />}
        </button>
        <button
          onClick={toggleScreenShare}
          className={`${styles.controlButton} ${isScreenSharing ? styles.activeStateButton : ''}`}
          title={isScreenSharing ? '画面共有を停止' : '画面共有を開始'}
          disabled={isScreenShareButtonDisabled}
        >
          <FiMonitor />
        </button>
        <button
          ref={settingsButtonRef}
          onClick={() => setShowDeviceSettings(!showDeviceSettings)}
          className={`${styles.controlButton} ${showDeviceSettings ? styles.activeStateButton : ''}`}
          title='デバイス設定'
        >
          <FiSettings />
        </button>
        <button
          onClick={leaveRoom}
          className={`${styles.controlButton} ${styles.leaveButton}`}
          title='退出'
        >
          <FiPhone />
        </button>
      </div>

      {/* ★ 右側コントロール (音量スライダー → 共有インジケーター) */}
      <div className={styles.rightControls}>
        {/* 画面共有ボリューム */}
        {screenSharingPeerId && screenSharingPeerId !== myPeerId && (
          <div className={styles.screenVolumeControl}>
            <FiMonitor className={styles.volumeIcon} />
            <input
              type='range'
              min='0'
              max='1'
              step='0.01'
              value={screenVolume}
              onChange={(e) =>
                handleScreenVolumeChange(parseFloat(e.target.value))
              }
              className={styles.screenVolumeSlider}
              title={`画面共有の音量: ${Math.round(screenVolume * 100)}%`}
            />
          </div>
        )}
        {/* 画面共有インジケーター */}
        {sharingParticipantName && (
          <div className={styles.footerSharingIndicator}>
            {sharingParticipantName}が画面共有中
          </div>
        )}
      </div>
    </div>
  )
}
