import { addSchema } from '../../utils/serialization/SchemaHelpers'
import { AJV_IDENT } from './Helpers'

const schemaApoptosisResp = {
  type: 'object',
  properties: {
    s: { type: 'string' },
    r: { type: 'number' },
  },
  required: ['s', 'r'],
}

export function initApoptosisProposalResp(): void {
  addSchemaDependencies()
  addSchemas()
}

// Function to add schema dependencies
function addSchemaDependencies(): void {
  // No dependencies
}

// Function to register the schema
function addSchemas(): void {
  addSchema(AJV_IDENT.APOPTOSIS_RESP, schemaApoptosisResp)
}
