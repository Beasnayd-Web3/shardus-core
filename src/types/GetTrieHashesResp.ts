import { VectorBufferStream } from '../utils/serialization/VectorBufferStream'
import { TypeIdentifierEnum } from './enum/TypeIdentifierEnum'

export type GetTrieHashesResponse = {
  nodeHashes: { radix: string; hash: string }[]
  nodeId?: string
}

const cGetTrieHashesRespVersion = 1

export function serializeGetTrieHashesResp(
  stream: VectorBufferStream,
  response: GetTrieHashesResponse,
  root = false
): void {
  if (root) {
    stream.writeUInt16(TypeIdentifierEnum.cGetTrieHashesResp)
  }

  stream.writeUInt8(cGetTrieHashesRespVersion)

  if(response.nodeId){
    stream.writeUInt8(1)
    stream.writeString(response.nodeId)
  }else{
    stream.writeUInt8(0)
  }

  stream.writeUInt32(response.nodeHashes.length || 0) 

  for (let i = 0; i < response.nodeHashes.length; i++) {
    if (!response.nodeHashes[i].radix || !response.nodeHashes[i].hash) {
      throw new Error('Missing radix or hash in serializeGetTrieHashesResp')
    }
    stream.writeString(response.nodeHashes[i].radix)
    stream.writeString(response.nodeHashes[i].hash)
  }

}

export function deserializeGetTrieHashesResp(stream: VectorBufferStream): GetTrieHashesResponse {
  const version = stream.readUInt8()
  if (version > cGetTrieHashesRespVersion) {
    throw new Error('Unsupported version in deserializeGetTrieHashesResp')
  }

  const is_nodeId = stream.readString()
  let nodeId = undefined

  if(is_nodeId){
    nodeId = stream.readString()
  }

  const length = stream.readUInt32() 
  const hashes = []

  for (let i = 0; i < length; i++) {
    const radix = stream.readString()
    const hash = stream.readString()
    hashes.push({ radix, hash })
  }
  return { nodeHashes: hashes, nodeId: nodeId }

}

