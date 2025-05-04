// src/app/types.ts
import type { Socket } from 'socket.io-client' // Socket.DisconnectReason のために必要

// CallScreen や useWebSocket などで共有される型

export type Participant = {
  id: string
  name: string
  isMuted: boolean
  isSelf: boolean
  stream?: MediaStream | null
  isSpeaking?: boolean
}

export type ServerParticipants = {
  [peerId: string]: string
}

export type RoomStatePayload = {
  participants: ServerParticipants
  currentSharerId: string | null
}

export type ScreenShareStatusPayload = {
  peerId: string
  isSharing: boolean
  sharerPeerId: string | null
}

export type UserJoinedPayload = {
  peerId: string
  name: string
}

export type JoinRoomPayload = {
  // useWebSocket で使用
  roomCode: string | undefined
  peerId: string
  name: string
}

export type LocalAudioAnalysisRefs = {
  // CallScreen で使用
  context: AudioContext | null
  analyser: AnalyserNode | null
  source: MediaStreamAudioSourceNode | null
  animationFrameId: number | null
  dataArray: Uint8Array | null
  isSpeaking: boolean
}

// 必要であれば Socket.DisconnectReason もエクスポート
export type DisconnectReason = Socket.DisconnectReason
