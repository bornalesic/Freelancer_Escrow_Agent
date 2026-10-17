# slugify

Turns any text into a URL-friendly slug.

```js
import { slugify } from './slugify.js';

slugify('Hello, World!'); // "hello-world"
```

- lowercases the text
- replaces spaces with dashes
- strips anything that isn't a letter, number or dash

Run the tests with `npm test` (no dependencies needed).
