import { VectorBufferStream } from '../utils/serialization/VectorBufferStream'
import { WrappedData, deserializeWrappedData, serializeWrappedData } from './WrappedData'
import { TypeIdentifierEnum } from './enum/TypeIdentifierEnum'

export const cWrappedDataResponseVersion = 1

export interface WrappedDataResponse extends WrappedData {
  accountCreated: boolean
  isPartial: boolean
}

export function serializeWrappedDataResponse(
  stream: VectorBufferStream,
  obj: WrappedDataResponse,
  root = false
): void {
  if (root) {
    stream.writeUInt16(TypeIdentifierEnum.cWrappedDataResponse)
  }
  stream.writeUInt16(cWrappedDataResponseVersion)
  serializeWrappedData(stream, obj)
  stream.writeUInt8(obj.accountCreated ? 1 : 0)
  stream.writeUInt8(obj.isPartial ? 1 : 0)
}

export function deserializeWrappedDataResponse(stream: VectorBufferStream): WrappedDataResponse {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const version = stream.readUInt16()
  const wrappedData = deserializeWrappedData(stream)
  return {
    ...wrappedData,
    accountCreated: stream.readUInt8() !== 0,
    isPartial: stream.readUInt8() !== 0,
  }
}
