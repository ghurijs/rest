import {
  BooleanField,
  CASCADE,
  CharField,
  DateTimeField,
  DecimalField,
  ForeignKey,
  IntegerField,
  JSONField,
  type Manager,
  ManyToManyField,
  Model,
  PositiveIntegerField,
  type RelatedManager,
  SET_NULL,
  SlugField,
  TextField,
} from '@ghuri/orm'

export class Member extends Model({
  username: new CharField({ maxLength: 50, unique: true }),
  isStaff: new BooleanField({ default: false }),
}) {
  declare static objects: Manager<Member>
  static Meta = { appLabel: 'blog', ordering: ['id'] }
  declare posts: RelatedManager<Post>
  toString(): string {
    return this.username
  }
}

export class Tag extends Model({
  name: new CharField({ maxLength: 30, unique: true }),
}) {
  declare static objects: Manager<Tag>
  static Meta = { appLabel: 'blog', ordering: ['name'] }
  toString(): string {
    return this.name
  }
}

export class Post extends Model({
  title: new CharField({ maxLength: 100, helpText: 'Headline' }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  published: new BooleanField({ default: false }),
  rating: new DecimalField({ maxDigits: 4, decimalPlaces: 2, null: true, blank: true }),
  status: new CharField({
    maxLength: 10,
    choices: [
      ['draft', 'Draft'],
      ['live', 'Live'],
    ],
    default: 'draft',
  }),
  views: new PositiveIntegerField({ default: 0 }),
  author: new ForeignKey(() => Member, { onDelete: CASCADE, relatedName: 'posts' }),
  editor: new ForeignKey(() => Member, {
    onDelete: SET_NULL,
    null: true,
    blank: true,
    relatedName: 'edited',
  }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  extra: new JSONField({ null: true, blank: true }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Post>
  static Meta = { appLabel: 'blog', ordering: ['id'] }
  get titleUpper(): string {
    return this.title.toUpperCase()
  }
  toString(): string {
    return this.title
  }
}

export class Comment extends Model({
  post: new ForeignKey(() => Post, { onDelete: CASCADE, relatedName: 'comments' }),
  rank: new IntegerField(),
  text: new CharField({ maxLength: 200 }),
}) {
  declare static objects: Manager<Comment>
  static Meta = { appLabel: 'blog', ordering: ['id'], uniqueTogether: [['post', 'rank']] }
}

export const allModels = [Member, Tag, Post, Comment]
