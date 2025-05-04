// src/app/components/CallControlsFooter/index.tsx
import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react'
import styles from './styles.module.css'
import type { Participant } from '../../type'
import { toast } from 'react-toastify'
import {
  FiMic,
  FiMicOff,
  FiMonitor,
  FiSettings,
  FiPhone,
  FiCheck,
  FiVolume2,
  FiVolumeX,
} from 'react-icons/fi'

// Props の型定義
type CallControlsFooterProps = {
  isMuted: boolean
  isScreenSharing: boolean
  microphones: MediaDeviceInfo[]
  speakers: MediaDeviceInfo[]
  selectedSpeakerId: string
  localStream: MediaStream | null
  toggleMic: () => void
  toggleScreenShare: () => void
  handleSpeakerChange: (event: React.ChangeEvent<HTMLSelectElement>) => void
  leaveRoom: () => void
  myPeerId: string
  participants: Participant[]
  screenSharingPeerId: string | null
  roomCode: string | undefined
  screenVideoRef: React.RefObject<HTMLVideoElement | null>
  isScreenShareButtonDisabled: boolean
  switchMicrophone: (deviceId: string) => Promise<void> // ★ マイク切り替え関数を受け取る
  stopLocalAudioAnalysis: () => void // ★ 音声解析停止関数も必要
}

export default function CallControlsFooter({
  isMuted,
  isScreenSharing,
  microphones,
  speakers,
  selectedSpeakerId,
  localStream,
  toggleMic,
  toggleScreenShare,
  handleSpeakerChange,
  leaveRoom,
  screenSharingPeerId,
  myPeerId,
  participants,
  screenVideoRef,
  roomCode,
  isScreenShareButtonDisabled,
  switchMicrophone, // ★ マイク切り替え関数を受け取る
  stopLocalAudioAnalysis, // ★ 音声解析停止関数を受け取る
}: CallControlsFooterProps) {
  const [showDeviceSettings, setShowDeviceSettings] = useState(false)
  const [isCopied, setIsCopied] = useState(false)
  const displayCode = useMemo(() => roomCode?.replace('room-', ''), [roomCode])
  const settingsPopupRef = useRef<HTMLDivElement>(null)
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const [screenVolume, setScreenVolume] = useState(0.7)
  const [selectedMicId, setSelectedMicId] = useState<string>('')
  const [isScreenShareMuted, setIsScreenShareMuted] = useState(false)

  const handleMicChange = useCallback(
    async (event: React.ChangeEvent<HTMLSelectElement>) => {
      const newMicId = event.target.value
      const currentMicId = selectedMicId // エラー時に戻すため保持
      setSelectedMicId(newMicId) // UI を即時反映
      try {
        stopLocalAudioAnalysis() // マイク変更前に解析を停止
        await switchMicrophone(newMicId) // Props の関数を呼び出し
        console.log(
          '[CallControlsFooter] Microphone switched successfully to:',
          newMicId
        )
      } catch (error) {
        console.error(
          '[CallControlsFooter] Failed to switch microphone:',
          error
        )
        toast.error(
          `マイクの切り替え失敗: ${error instanceof Error ? error.message : String(error)}`
        )
        setSelectedMicId(currentMicId) // エラー時は選択を元に戻す
      }
    },
    [selectedMicId, switchMicrophone, stopLocalAudioAnalysis] // 依存配列
  )
  // ★ デフォルトマイクIDを設定する Effect
  useEffect(() => {
    if (!selectedMicId && microphones.length > 0) {
      const defaultMic =
        microphones.find((mic) => mic.deviceId === 'default') || microphones[0]
      setSelectedMicId(defaultMic.deviceId)
      console.log(
        '[CallControlsFooter] Setting default Mic ID:',
        defaultMic.deviceId
      )
    }
  }, [microphones, selectedMicId]) // microphones が読み込まれた後、selectedMicId が空なら実行

  const handleScreenVolumeChange = useCallback(
    (volume: number) => {
      setScreenVolume(volume)
      if (screenVideoRef.current) {
        screenVideoRef.current.volume = volume
        // ★ 音量スライダー操作でミュート解除
        if (volume > 0 && isScreenShareMuted) {
          setIsScreenShareMuted(false)
          screenVideoRef.current.muted = false
        }
        // ★ 音量が0になったらミュート状態にする (任意)
        if (volume === 0 && !isScreenShareMuted) {
          setIsScreenShareMuted(true)
          screenVideoRef.current.muted = true
        }
      }
    },
    [screenVideoRef, isScreenShareMuted]
  )

  //  画面共有ミュート切り替え関数
  const toggleScreenShareMute = useCallback(() => {
    const nextMutedState = !isScreenShareMuted
    setIsScreenShareMuted(nextMutedState)
    if (screenVideoRef.current) {
      screenVideoRef.current.muted = nextMutedState
      // ミュート解除時に音量が0だったら少し戻す (任意)
      if (!nextMutedState && screenVideoRef.current.volume === 0) {
        const defaultVolume = 0.5 // または以前の音量を記憶しておくなど
        setScreenVolume(defaultVolume)
        screenVideoRef.current.volume = defaultVolume
      }
    }
  }, [isScreenShareMuted, screenVideoRef])

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

  // ★ 画面共有ボタンのクリックハンドラ (Toast 表示ロジック含む)
  const handleScreenShareButtonClick = useCallback(() => {
    if (isScreenShareButtonDisabled) {
      // 他の人が共有中の場合、Toast を表示
      toast.warn('他のユーザーが画面共有中です。')
    } else {
      // 誰も共有していないか、自分が共有中の場合、元の関数を実行
      toggleScreenShare()
    }
  }, [isScreenShareButtonDisabled, toggleScreenShare]) // 依存配列

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
          onClick={handleScreenShareButtonClick}
          className={`
            ${styles.controlButton}
            ${isScreenSharing ? styles.sharingActive : ''}
          `}
          title={isScreenSharing ? '画面共有を停止' : '画面共有を開始'}
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
            <button
              onClick={toggleScreenShareMute}
              className={`${styles.iconButton} ${styles.volumeIconToggle}`} // 新しいスタイルクラスを追加 (任意)
              title={isScreenShareMuted ? 'ミュート解除' : 'ミュート'}
            >
              {isScreenShareMuted ? <FiVolumeX /> : <FiVolume2 />}
            </button>
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
