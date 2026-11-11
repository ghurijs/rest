import { ValidationError as CoreValidationError } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import {
  BooleanField,
  CharField,
  ChoiceField,
  CreateOnlyDefault,
  CurrentUserDefault,
  DateField,
  DateTimeField,
  DecimalField,
  DictField,
  DurationField,
  EmailField,
  FileField,
  FloatField,
  HiddenField,
  ImageField,
  IntegerField,
  IPAddressField,
  JSONField,
  ListField,
  ListSerializer,
  MultipleChoiceField,
  ReadOnlyField,
  RegexField,
  Serializer,
  SerializerMethodField,
  SlugField,
  TimeField,
  URLField,
  UUIDField,
  ValidationError,
} from '../src/index'

async function check(
  field: any,
  input: unknown,
): Promise<{ ok: boolean; value?: unknown; errors?: unknown }> {
  class S extends Serializer {
    f = field
  }
  const s = new S({ data: input === undefined ? {} : { f: input } })
  const ok = await s.isValid()
  return ok ? { ok, value: s.validatedData.f } : { ok, errors: s.errors.f }
}

describe('fields', () => {
  it('BooleanField', async () => {
    expect(await check(new BooleanField(), 'true')).toEqual({ ok: true, value: true })
    expect(await check(new BooleanField(), 0)).toEqual({ ok: true, value: false })
    expect(await check(new BooleanField(), 'maybe')).toEqual({
      ok: false,
      errors: ['Must be a valid boolean.'],
    })
    expect(await check(new BooleanField({ allowNull: true }), '')).toEqual({ ok: true, value: null })
    expect(new BooleanField().toRepresentation(1)).toBe(true)
  })

  it('CharField trims, blank and length rules', async () => {
    expect(await check(new CharField(), '  hi ')).toEqual({ ok: true, value: 'hi' })
    expect(await check(new CharField(), '   ')).toEqual({
      ok: false,
      errors: ['This field may not be blank.'],
    })
    expect(await check(new CharField({ allowBlank: true }), '')).toEqual({ ok: true, value: '' })
    expect(await check(new CharField({ maxLength: 3 }), 'abcd')).toEqual({
      ok: false,
      errors: ['Ensure this field has no more than 3 characters.'],
    })
    expect(await check(new CharField({ minLength: 3 }), 'ab')).toEqual({
      ok: false,
      errors: ['Ensure this field has at least 3 characters.'],
    })
    expect(await check(new CharField(), 12)).toEqual({ ok: true, value: '12' })
    expect(await check(new CharField(), true)).toEqual({ ok: false, errors: ['Not a valid string.'] })
    expect(await check(new CharField(), null)).toEqual({ ok: false, errors: ['This field may not be null.'] })
    expect(await check(new CharField(), undefined)).toEqual({
      ok: false,
      errors: ['This field is required.'],
    })
    expect(await check(new CharField({ required: false }), undefined)).toEqual({ ok: true, value: undefined })
    expect(await check(new CharField({ default: 'x' }), undefined)).toEqual({ ok: true, value: 'x' })
  })

  it('string formats', async () => {
    expect((await check(new EmailField(), 'a@b.co')).ok).toBe(true)
    expect(await check(new EmailField(), 'nope')).toEqual({
      ok: false,
      errors: ['Enter a valid email address.'],
    })
    expect((await check(new URLField(), 'https://ghuri.dev/x')).ok).toBe(true)
    expect(await check(new URLField(), 'ghuri')).toEqual({ ok: false, errors: ['Enter a valid URL.'] })
    expect((await check(new SlugField(), 'a-b_c')).ok).toBe(true)
    expect((await check(new SlugField(), 'a b')).ok).toBe(false)
    expect((await check(new RegexField(/^\d+$/), '12')).ok).toBe(true)
    expect(await check(new RegexField(/^\d+$/), 'x')).toEqual({
      ok: false,
      errors: ['This value does not match the required pattern.'],
    })
    expect(await check(new UUIDField(), '6F9619FF8B86D011B42D00C04FC964FF')).toEqual({
      ok: true,
      value: '6f9619ff-8b86-d011-b42d-00c04fc964ff',
    })
    expect(await check(new UUIDField(), 'x')).toEqual({ ok: false, errors: ['Must be a valid UUID.'] })
    expect((await check(new IPAddressField(), '10.0.0.1')).ok).toBe(true)
    expect((await check(new IPAddressField(), '::1')).ok).toBe(true)
    expect((await check(new IPAddressField({ protocol: 'ipv4' }), '::1')).ok).toBe(false)
  })

  it('numbers', async () => {
    expect(await check(new IntegerField(), '42')).toEqual({ ok: true, value: 42 })
    expect(await check(new IntegerField(), '4.0')).toEqual({ ok: true, value: 4 })
    expect(await check(new IntegerField(), 4.5)).toEqual({
      ok: false,
      errors: ['A valid integer is required.'],
    })
    expect(await check(new IntegerField({ maxValue: 10 }), 11)).toEqual({
      ok: false,
      errors: ['Ensure this value is less than or equal to 10.'],
    })
    expect(await check(new FloatField(), '1.5')).toEqual({ ok: true, value: 1.5 })
    expect(await check(new FloatField(), 'NaN')).toEqual({
      ok: false,
      errors: ['A valid number is required.'],
    })
    const dec = new DecimalField({ maxDigits: 5, decimalPlaces: 2 })
    expect(await check(dec, '12.3')).toEqual({ ok: true, value: '12.30' })
    expect(await check(new DecimalField({ maxDigits: 5, decimalPlaces: 2 }), 1.239)).toEqual({
      ok: false,
      errors: ['Ensure that there are no more than 2 decimal places.'],
    })
    expect(await check(new DecimalField({ maxDigits: 5, decimalPlaces: 2 }), '1234.5')).toEqual({
      ok: false,
      errors: ['Ensure that there are no more than 3 digits before the decimal point.'],
    })
    expect(new DecimalField({ decimalPlaces: 2 }).toRepresentation('3.14159')).toBe('3.14')
    expect(new DecimalField({ decimalPlaces: 2, coerceToString: false }).toRepresentation('3.145')).toBe(3.14)
  })

  it('dates and durations', async () => {
    const dt = await check(new DateTimeField(), '2024-05-01T10:20:30+02:00')
    expect((dt.value as Date).toISOString()).toBe('2024-05-01T08:20:30.000Z')
    expect(((await check(new DateTimeField(), '2024-05-01T10:20')).value as Date).toISOString()).toBe(
      '2024-05-01T10:20:00.000Z',
    )
    expect(await check(new DateTimeField(), '2024-05-01')).toEqual({
      ok: false,
      errors: ['Expected a datetime but got a date.'],
    })
    expect((await check(new DateTimeField(), 'yesterday')).ok).toBe(false)
    expect(new DateTimeField().toRepresentation(new Date('2024-01-02T03:04:05Z'))).toBe(
      '2024-01-02T03:04:05Z',
    )
    expect(await check(new DateField(), '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' })
    expect(await check(new DateField(), '2023-02-29')).toEqual({
      ok: false,
      errors: ['Date has wrong format. Use one of these formats instead: YYYY-MM-DD.'],
    })
    expect(await check(new TimeField(), '09:30')).toEqual({ ok: true, value: '09:30:00' })
    expect(await check(new DurationField(), '1 02:03:04')).toEqual({ ok: true, value: 93784000 })
    expect(await check(new DurationField(), 'P1DT2H')).toEqual({ ok: true, value: 93600000 })
    expect(new DurationField().toRepresentation(93784500)).toBe('1 02:03:04.500000')
  })

  it('choices', async () => {
    const f = () =>
      new ChoiceField([
        ['a', 'Alpha'],
        ['b', 'Beta'],
      ])
    expect(await check(f(), 'a')).toEqual({ ok: true, value: 'a' })
    expect(await check(f(), 'z')).toEqual({ ok: false, errors: ['"z" is not a valid choice.'] })
    expect(await check(new ChoiceField([1, 2]), '2')).toEqual({ ok: true, value: 2 })
    expect(await check(new MultipleChoiceField(['x', 'y']), ['x', 'x', 'y'])).toEqual({
      ok: true,
      value: ['x', 'y'],
    })
    expect(await check(new MultipleChoiceField(['x']), 'x')).toEqual({
      ok: false,
      errors: ['Expected a list of items but got type "str".'],
    })
  })

  it('composite fields', async () => {
    expect(await check(new ListField({ child: new IntegerField() }), ['1', 2])).toEqual({
      ok: true,
      value: [1, 2],
    })
    expect(await check(new ListField({ child: new IntegerField() }), ['1', 'x'])).toEqual({
      ok: false,
      errors: { 1: ['A valid integer is required.'] },
    })
    expect(await check(new ListField({ allowEmpty: false }), [])).toEqual({
      ok: false,
      errors: ['This list may not be empty.'],
    })
    expect(await check(new DictField({ child: new BooleanField() }), { a: 'yes' })).toEqual({
      ok: true,
      value: { a: true },
    })
    expect(await check(new DictField(), [])).toEqual({
      ok: false,
      errors: ['Expected a dictionary of items but got type "list".'],
    })
    expect(await check(new JSONField(), { a: [1, { b: null }] })).toEqual({
      ok: true,
      value: { a: [1, { b: null }] },
    })
  })

  it('file fields', async () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    expect(await check(new FileField(), file)).toEqual({ ok: true, value: file })
    expect(await check(new FileField(), 'nope')).toEqual({
      ok: false,
      errors: ['The submitted data was not a file. Check the encoding type on the form.'],
    })
    expect(await check(new FileField(), new File([], 'empty.txt'))).toEqual({
      ok: false,
      errors: ['The submitted file is empty.'],
    })
    expect((await check(new ImageField(), file)).errors).toEqual([
      'Upload a valid image. The file you uploaded was either not an image or a corrupted image.',
    ])
    expect(
      (await check(new ImageField(), new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))).ok,
    ).toBe(true)
    expect(new FileField().toRepresentation({ name: 'a/b.txt', url: '/media/a/b.txt' })).toBe(
      '/media/a/b.txt',
    )
    expect(
      new FileField({ useUrl: false }).toRepresentation({ name: 'a/b.txt', url: '/media/a/b.txt' }),
    ).toBe('a/b.txt')
  })
})

class CommentSerializer extends Serializer {
  email = new EmailField()
  content = new CharField({ maxLength: 200 })
  created = new DateTimeField({ readOnly: true })
  score = new IntegerField({ required: false, default: 0 })

  validateContent(value: string) {
    if (value.includes('spam')) throw new CoreValidationError('No spam please.')
    return value.toUpperCase()
  }

  async validate(attrs: any) {
    if (attrs.email?.endsWith('@blocked.com')) throw new ValidationError('Blocked domain.')
    return attrs
  }

  async create(data: any) {
    return { ...data, created: new Date('2024-01-01T00:00:00Z') }
  }

  async update(instance: any, data: any) {
    return { ...instance, ...data }
  }
}

describe('Serializer', () => {
  it('validates, runs hooks and saves', async () => {
    const s = new CommentSerializer({ data: { email: 'leila@example.com', content: 'foo bar' } })
    expect(await s.isValid()).toBe(true)
    expect(s.validatedData).toEqual({ email: 'leila@example.com', content: 'FOO BAR', score: 0 })
    expect(s.errors).toEqual({})
    const obj = await s.save({ extra: 1 })
    expect(obj).toMatchObject({ extra: 1, content: 'FOO BAR' })
    expect(await s.getData()).toEqual({
      email: 'leila@example.com',
      content: 'FOO BAR',
      created: '2024-01-01T00:00:00Z',
      score: 0,
    })
    expect(s.data).toEqual(await s.getData())
  })

  it('collects field errors, core ValidationErrors and object-level errors', async () => {
    const s = new CommentSerializer({ data: { email: 'bad', content: 'spam!' } })
    expect(await s.isValid()).toBe(false)
    expect(s.errors).toEqual({ email: ['Enter a valid email address.'], content: ['No spam please.'] })
    const blocked = new CommentSerializer({ data: { email: 'x@blocked.com', content: 'hi' } })
    expect(await blocked.isValid()).toBe(false)
    expect(blocked.errors).toEqual({ nonFieldErrors: ['Blocked domain.'] })
    await expect(blocked.isValid({ raiseException: true })).rejects.toBeInstanceOf(ValidationError)
    const notDict = new CommentSerializer({ data: [1, 2] })
    expect(await notDict.isValid()).toBe(false)
    expect(notDict.errors).toEqual({ nonFieldErrors: ['Invalid data. Expected a dictionary, but got list.'] })
  })

  it('keeps error codes', async () => {
    const s = new CommentSerializer({ data: { email: 'bad' } })
    try {
      await s.isValid({ raiseException: true })
      expect.unreachable()
    } catch (err) {
      expect((err as ValidationError).getCodes()).toEqual({ email: ['invalid'], content: ['required'] })
      expect((err as ValidationError).getFullDetails()).toMatchObject({
        content: [{ message: 'This field is required.', code: 'required' }],
      })
    }
  })

  it('guards misuse like DRF', async () => {
    const s = new CommentSerializer({ data: {} })
    expect(() => s.errors).toThrow(/isValid/)
    await expect(s.getData()).rejects.toThrow(/isValid/)
    await expect(s.save()).rejects.toThrow(/isValid/)
    await expect(new CommentSerializer().isValid()).rejects.toThrow(/no `data`/)
    expect(() => new CommentSerializer({ instance: {} }).data).toThrow(/getData/)
  })

  it('supports partial updates', async () => {
    const instance = { email: 'a@b.co', content: 'X', created: new Date('2024-01-01T00:00:00Z'), score: 3 }
    const s = new CommentSerializer({ instance, data: { content: 'new' }, partial: true })
    expect(await s.isValid()).toBe(true)
    expect(s.validatedData).toEqual({ content: 'NEW' })
    const updated = await s.save()
    expect(updated).toMatchObject({ email: 'a@b.co', content: 'NEW', score: 3 })
  })

  it('serializes lists with many: true', async () => {
    const items = [
      { email: 'a@b.co', content: 'one', created: new Date('2024-01-01T00:00:00Z'), score: 1 },
      { email: 'c@d.co', content: 'two', created: null, score: 2 },
    ]
    const s = new CommentSerializer({ instance: items, many: true })
    expect(s).toBeInstanceOf(ListSerializer)
    expect(await s.getData()).toEqual([
      { email: 'a@b.co', content: 'one', created: '2024-01-01T00:00:00Z', score: 1 },
      { email: 'c@d.co', content: 'two', created: null, score: 2 },
    ])
    const many = CommentSerializer.many({
      data: [
        { email: 'a@b.co', content: 'ok' },
        { email: 'x', content: 'ok' },
      ],
    })
    expect(await many.isValid()).toBe(false)
    expect(many.errors).toEqual([{}, { email: ['Enter a valid email address.'] }])
    const notList = CommentSerializer.many({ data: { a: 1 } })
    expect(await notList.isValid()).toBe(false)
    expect(notList.errors).toEqual({ nonFieldErrors: ['Expected a list of items but got type "dict".'] })
    const creates = CommentSerializer.many({ data: [{ email: 'a@b.co', content: 'ok' }] })
    expect(await creates.isValid()).toBe(true)
    expect(await creates.save({ tag: 't' })).toEqual([expect.objectContaining({ content: 'OK', tag: 't' })])
  })

  it('handles source paths, method fields, defaults and read-only output', async () => {
    class ProfileSerializer extends Serializer {
      name = new CharField({ source: 'user.name' })
      city = new CharField({ source: 'user.address.city', required: false })
      greeting = new SerializerMethodField()
      upper = new ReadOnlyField({ source: 'shout' })
      secret = new CharField({ writeOnly: true })
      owner = new HiddenField({ default: new CurrentUserDefault() })
      createdBy = new CharField({ default: new CreateOnlyDefault('system') })

      async getGreeting(obj: any) {
        return `Hello ${await obj.user.then((u: any) => u.name)}`
      }
    }
    const instance = {
      user: Promise.resolve({ name: 'Ann', address: null }),
      shout() {
        return 'HEY'
      },
      secret: 'x',
    }
    const out = await new ProfileSerializer({ instance }).getData()
    // CreateOnlyDefault skips the field when there is an instance (like DRF).
    expect(out).toEqual({ name: 'Ann', city: null, greeting: 'Hello Ann', upper: 'HEY' })

    const s = new ProfileSerializer({
      data: { name: 'Bo', secret: 's' },
      context: { request: { user: { pk: 7 } } },
    })
    expect(await s.isValid()).toBe(true)
    expect(s.validatedData).toEqual({
      user: { name: 'Bo' },
      secret: 's',
      owner: { pk: 7 },
      createdBy: 'system',
    })
  })

  it('produces JSON Schema for input and output', () => {
    const output = CommentSerializer.jsonSchema()
    expect(output).toEqual({
      type: 'object',
      title: 'Comment',
      properties: {
        email: { type: 'string', format: 'email', minLength: 1, title: 'Email' },
        content: { type: 'string', maxLength: 200, minLength: 1, title: 'Content' },
        created: { type: 'string', format: 'date-time', title: 'Created', readOnly: true },
        score: { type: 'integer', title: 'Score', default: 0 },
      },
      required: ['email', 'content', 'created'],
    })
    const input = new CommentSerializer().jsonSchema({ mode: 'input' })
    expect(Object.keys(input.properties)).toEqual(['email', 'content', 'score'])
    expect(input.required).toEqual(['email', 'content'])
    expect(new CommentSerializer().jsonSchema({ mode: 'input', partial: true }).required).toBeUndefined()
  })
})
