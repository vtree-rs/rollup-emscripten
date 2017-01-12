
# rollup-emscripten

Uses *rollup* to bundle multiple modules then converts the ouput to the *Emscripten* library format.

## Examples

```javascript
import rollupEmscripten from 'rollup-emscripten';

rollupEmscripten({
	entry: './my-lib.js',
	localPrefix: 'myLib', // prefix for local symbols
	// ...other rollup options
}).then(result => result.write('output.js'));
```

with *babel*:

```javascript
import rollupEmscripten from 'rollup-emscripten';
import rollupBabel from 'rollup-plugin-babel';

rollupEmscripten({
	entry: './my-lib.js',
	localPrefix: 'myLib', // prefix for local symbols
	plugins: [
		rollupBabel({
			babelrc: false,
			presets: [
				['es2015', {modules: false}],
			],
		}),
	]
}).then(result => result.write('output.js'));
```
