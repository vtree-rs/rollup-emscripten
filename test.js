'use strict';

/* eslint-env jest */

const rollupEmscripten = require('./').default;

expect.addSnapshotSerializer({
	test: value => typeof value === 'string',
	print: value => value,
});

function rtest(name, code) {
	test(name, () => rollupEmscripten({
		entry: 'test.js',
		localPrefix: 'test',
		plugins: [{
			load: () => code,
		}],
	}).then(result => result.code, error => error.message).then(result => {
		expect(result).toMatchSnapshot();
	}));
}

rtest('unsupported top-level statement', `
	sideEffect();
`);

rtest('local function referenced by exported one', `
	function x() {}

	export function y() {
		return x();
	}
`);

rtest('exported function referenced by another one', `
	export function x() {}

	export function y() {
		return x();
	}
`);

rtest('pure local variable used by exported function', `
	var x = 10 + 20 - ~30;

	export function getX() {
		return x;
	}
`);

rtest('impure local variable used by exported function', `
	var x = new ArrayBuffer(10);

	export function getX() {
		return x;
	}
`);

rtest('exported local variable using a local function', `
	export var x = getX();

	function getX() {
		return 42;
	}
`);

rtest('exporting a variable and a function with custom names', `
	var localVar = 10;

	function localFunc() {}

	export {
		localVar as exportedVar,
		localFunc as exportedFunc
	};
`);
