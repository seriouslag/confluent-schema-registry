import path from 'path'
import { v4 as uuid } from 'uuid'

import { readAVSC } from './utils'
import SchemaRegistry from './SchemaRegistry'
import { ConfluentSubject, ConfluentSchema, SchemaType } from './@types'
import API from './api'
import { COMPATIBILITY, DEFAULT_API_CLIENT_ID } from './constants'
import encodedAnotherPersonV2 from '../fixtures/encodedAnotherPersonV2'
import wrongMagicByte from '../fixtures/wrongMagicByte'

const REGISTRY_HOST = 'http://localhost:8982'
const schemaRegistryAPIClientArgs = { host: REGISTRY_HOST }
const schemaRegistryArgs = { host: REGISTRY_HOST }

const personSchema = readAVSC(path.join(__dirname, '../fixtures/avsc/person.avsc'))
const subject: ConfluentSubject = { name: [personSchema.namespace, personSchema.name].join('.') }
const schema: ConfluentSchema = {
  type: SchemaType.AVRO,
  schemaString: JSON.stringify(personSchema),
}

const payload = { full_name: 'John Doe' } // eslint-disable-line @typescript-eslint/camelcase

describe('SchemaRegistry', () => {
  let schemaRegistry: SchemaRegistry

  beforeEach(async () => {
    schemaRegistry = new SchemaRegistry(schemaRegistryArgs)
    await schemaRegistry.register(schema, subject)
  })

  describe('#register', () => {
    let namespace,
      Schema,
      subject,
      api,
      confluentSubject: ConfluentSubject,
      confluentSchema: ConfluentSchema

    const schemaStringsByType = {
      [SchemaType.AVRO.toString()]: namespace => `
        {
          "type": "record",
          "name": "RandomTest",
          "namespace": "${namespace}",
          "fields": [{ "type": "string", "name": "full_name" }]
        }
      `,
      [SchemaType.JSON.toString()]: namespace => `
        {
          "definitions" : {
            "record:${namespace}.RandomTest" : {
              "type" : "object",
              "required" : [ "full_name" ],
              "additionalProperties" : false,
              "properties" : {
                "full_name" : {
                  "type" : "string"
                }
              }
            }
          },
          "$ref" : "#/definitions/record:${namespace}.RandomTest"
        }
      `,
      [SchemaType.PROTOBUF.toString()]: namespace => `
        message RandomTest {
          required string full_name = 1;
        }
      `,
    }
    const types = Object.keys(schemaStringsByType).map(str => SchemaType[str])

    types.forEach(type =>
      describe(`${type.toString()}`, () => {
        beforeEach(() => {
          api = API(schemaRegistryAPIClientArgs)
          namespace = `N${uuid().replace(/-/g, '_')}`
          subject = `${namespace}.RandomTest`
          Schema = schemaStringsByType[type.toString()](namespace)
          confluentSubject = { name: subject }
          confluentSchema = { type, schemaString: Schema }
        })

        it('uploads the new schema', async () => {
          await expect(api.Subject.latestVersion({ subject })).rejects.toHaveProperty(
            'message',
            `${DEFAULT_API_CLIENT_ID} - Subject '${subject}' not found.`,
          )

          await expect(schemaRegistry.register(confluentSchema, confluentSubject)).resolves.toEqual(
            {
              id: expect.any(Number),
            },
          )
        })

        it('automatically cache the id and schema', async () => {
          const { id } = await schemaRegistry.register(confluentSchema, confluentSubject)

          expect(schemaRegistry.cache.getSchema(id)).toBeTruthy()
        })

        it('fetch and validate the latest schema id after registering a new schema', async () => {
          const { id } = await schemaRegistry.register(confluentSchema, confluentSubject)
          const latestSchemaId = await schemaRegistry.getLatestSchemaId(subject)

          expect(id).toBe(latestSchemaId)
        })

        it('set the default compatibility to BACKWARD', async () => {
          await schemaRegistry.register(confluentSchema, confluentSubject)
          const response = await api.Subject.config({ subject })
          expect(response.data()).toEqual({ compatibilityLevel: COMPATIBILITY.BACKWARD })
        })

        it('sets the compatibility according to param', async () => {
          await schemaRegistry.register(confluentSchema, confluentSubject, {
            compatibility: COMPATIBILITY.NONE,
          })
          const response = await api.Subject.config({ subject })
          expect(response.data()).toEqual({ compatibilityLevel: COMPATIBILITY.NONE })
        })

        it('throws an error when the configured compatibility is different than defined in the client', async () => {
          await schemaRegistry.register(confluentSchema, confluentSubject)
          await api.Subject.updateConfig({ subject, body: { compatibility: COMPATIBILITY.FULL } })
          await expect(
            schemaRegistry.register(confluentSchema, confluentSubject),
          ).rejects.toHaveProperty(
            'message',
            'Compatibility does not match the configuration (BACKWARD != FULL)',
          )
        })

        it('throws an error when the given schema string is invalid', async () => {
          const invalidSchema = `
        {
          "type": "record",
          "name": "RandomTest",
          "namespace": "${namespace}",
        }
      `
          const invalidConfluentSchema: ConfluentSchema = {
            type,
            schemaString: invalidSchema,
          }
          await expect(
            schemaRegistry.register(invalidConfluentSchema, confluentSubject),
          ).rejects.toHaveProperty(
            'message',
            'Confluent_Schema_Registry - Either the input schema or one its references is invalid',
          )
        })
      }),
    )
  })

  describe('#encode', () => {
    beforeEach(async () => {
      await schemaRegistry.register(schema, subject)
    })

    it('throws an error if registryId is empty', async () => {
      await expect(schemaRegistry.encode(undefined, payload)).rejects.toHaveProperty(
        'message',
        'Invalid registryId: undefined',
      )
    })

    it('encodes using a defined registryId', async () => {
      const SchemaV1 = Object.assign({}, personSchema, {
        name: 'AnotherPerson',
        fields: [{ type: 'string', name: 'full_name' }],
      })
      const SchemaV2 = Object.assign({}, SchemaV1, {
        fields: [
          { type: 'string', name: 'full_name' },
          { type: 'string', name: 'city', default: 'Stockholm' },
        ],
      })

      const confluentSchemaV1: ConfluentSchema = {
        type: SchemaType.AVRO,
        schemaString: JSON.stringify(SchemaV1),
      }
      const confluentSchemaV2: ConfluentSchema = {
        type: SchemaType.AVRO,
        schemaString: JSON.stringify(SchemaV2),
      }

      const schema1 = await schemaRegistry.register(confluentSchemaV1, { name: 'test1' })
      const schema2 = await schemaRegistry.register(confluentSchemaV2, { name: 'test2' })
      expect(schema2.id).not.toEqual(schema1.id)

      const data = await schemaRegistry.encode(schema2.id, payload)

      expect(data).toMatchConfluentAvroEncodedPayload({
        registryId: schema2.id,
        payload: Buffer.from(encodedAnotherPersonV2),
      })
    })
  })

  describe('#decode', () => {
    let registryId

    beforeEach(async () => {
      registryId = (await schemaRegistry.register(schema, subject)).id
    })

    it('decodes data', async () => {
      const buffer = Buffer.from(await schemaRegistry.encode(registryId, payload))
      const data = await schemaRegistry.decode(buffer)

      expect(data).toEqual(payload)
    })

    it('throws an error if the magic byte is not supported', async () => {
      const buffer = Buffer.from(wrongMagicByte)
      await expect(schemaRegistry.decode(buffer)).rejects.toHaveProperty(
        'message',
        'Message encoded with magic byte {"type":"Buffer","data":[48]}, expected {"type":"Buffer","data":[0]}',
      )
    })

    it('caches the schema', async () => {
      const buffer = Buffer.from(await schemaRegistry.encode(registryId, payload))

      schemaRegistry.cache.clear()
      await schemaRegistry.decode(buffer)

      expect(schemaRegistry.cache.getSchema(registryId)).toBeTruthy()
    })

    it('creates a single origin request for a schema cache-miss', async () => {
      const buffer = Buffer.from(await schemaRegistry.encode(registryId, payload))

      schemaRegistry.cache.clear()

      const spy = jest.spyOn((schemaRegistry as any).api.Schema, 'find')

      await Promise.all([
        schemaRegistry.decode(buffer),
        schemaRegistry.decode(buffer),
        schemaRegistry.decode(buffer),
      ])

      expect(spy).toHaveBeenCalledTimes(1)
    })

    describe('when the cache is populated', () => {
      it('uses the cache data', async () => {
        const buffer = Buffer.from(await schemaRegistry.encode(registryId, payload))
        expect(schemaRegistry.cache.getSchema(registryId)).toBeTruthy()

        jest.spyOn(schemaRegistry.cache, 'setSchema')
        await schemaRegistry.decode(buffer)

        expect(schemaRegistry.cache.setSchema).not.toHaveBeenCalled()
      })
    })
  })

  describe('#getRegistryIdBySchema', () => {
    let namespace, confluentSubject: ConfluentSubject, confluentSchema: ConfluentSchema

    beforeEach(() => {
      namespace = `N${uuid().replace(/-/g, '_')}`
      const subject = `${namespace}.RandomTest`
      const schema = `
        {
          "type": "record",
          "name": "RandomTest",
          "namespace": "${namespace}",
          "fields": [{ "type": "string", "name": "full_name" }]
        }
      `
      confluentSubject = { name: subject }
      confluentSchema = { type: SchemaType.AVRO, schemaString: schema }
    })

    it('returns the registry id if the schema has already been registered under that subject', async () => {
      const { id } = await schemaRegistry.register(confluentSchema, confluentSubject)

      await expect(
        schemaRegistry.getRegistryIdBySchema(confluentSubject.name, confluentSchema),
      ).resolves.toEqual(id)
    })

    it('throws an error if the subject does not exist', async () => {
      await expect(
        schemaRegistry.getRegistryIdBySchema(confluentSubject.name, confluentSchema),
      ).rejects.toHaveProperty(
        'message',
        `Confluent_Schema_Registry - Subject '${confluentSubject.name}' not found.`,
      )
    })

    it('throws an error if the schema has not been registered under that subject', async () => {
      const otherSchema = `
      {
        "type": "record",
        "name": "RandomTest",
        "namespace": "${namespace}",
        "fields": [{ "type": "string", "name": "not_full_name" }]
      }
    `
      const confluentOtherSchema: ConfluentSchema = {
        type: SchemaType.AVRO,
        schemaString: otherSchema,
      }

      await schemaRegistry.register(confluentOtherSchema, confluentSubject)

      await expect(
        schemaRegistry.getRegistryIdBySchema(confluentSubject.name, confluentSchema),
      ).rejects.toHaveProperty('message', 'Confluent_Schema_Registry - Schema not found')
    })
  })
})
