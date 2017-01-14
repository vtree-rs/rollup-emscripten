/* eslint-disable no-param-reassign */

import {rollup} from 'rollup';
import {parse} from 'acorn';
import {analyze} from 'escope';
import {generate} from 'escodegen';
import {writeFile} from 'js-utils-fs';
import mkdirp from 'mkdirp-promise';
import {dirname} from 'path';

// https://github.com/evanw/emscripten-library-generator/blob/5038b54bb8b5906572b09bc370f4b249776f2a3f/generator.js#L9-L19
function isPureValue(value) {
	return (
		value.type === 'Literal' ||
		value.type === 'ThisExpression' ||
		value.type === 'FunctionExpression' ||
		value.type === 'UnaryExpression' && isPureValue(value.argument) ||
		value.type === 'ArrayExpression' && value.elements.every(isPureValue) ||
		value.type === 'ObjectExpression' && value.properties.every(e => isPureValue(e.value)) ||
		(
			value.type === 'BinaryExpression' || value.type === 'LogicalExpression') &&
			isPureValue(value.left) && isPureValue(value.right
		)
	);
}

class EmscriptenTransform {
	constructor(input, localPrefix = 'unnamed') {
		this._localPrefix = localPrefix;
		this._input = input;
		this._dependencies = {};
		this._exports = {}; // [localName] = exportedName
	}

	_checkNodes() {
		this._input.body.forEach(node => {
			if (node.type === 'VariableDeclaration') {
				node.declarations.forEach(dec => {
					if (dec.init && !isPureValue(dec.init)) {
						const nodeJson = JSON.stringify(dec, undefined, '  ');
						throw new Error(`Unsupported non-pure initializer:\n${nodeJson}`);
					}
				});
			} else if (
				node.type !== 'FunctionDeclaration' &&
				node.type !== 'ExportNamedDeclaration'
			) {
				const nodeJson = JSON.stringify(node, undefined, '  ');
				throw new Error(`Unsupported top-level statement:\n${nodeJson}`);
			}
		});
	}

	_determineAndNormalizeExports() {
		this._input.body = this._input.body
			.map(node => {
				if (node.type !== 'ExportNamedDeclaration') return node;

				if (node.declaration) {
					const {name} = node.declaration.id;
					this._exports[name] = name;
					return node.declaration;
				}

				node.specifiers.forEach(n => {
					this._exports[n.local.name] = n.exported.name;
				});
				return undefined;
			})
			.filter(node => !!node);
	}

	_prefixName(name) {
		return `_${this._localPrefix}_${name}`;
	}

	_prefixLocalAndDetermineDeps() {
		analyze(this._input, {ecmaVersion: 6, sourceType: 'module'}).scopes.forEach(scope => {
			if (scope.type !== 'module') return;

			scope.variables.forEach(v => {
				v.references.forEach(ref => {
					let funcScope = ref.from;
					while (
						funcScope.upper && (
							funcScope.upper.type !== 'module' ||
							funcScope.type !== 'function' ||
							!funcScope.block.id
						)
					) {
						funcScope = funcScope.upper;
					}
					if (funcScope.upper) {
						let funcName = funcScope.block.id.name;
						if (!this._exports[funcName]) {
							funcName = this._prefixName(funcName);
						}
						let depName = v.name;
						if (!this._exports[depName]) {
							depName = this._prefixName(depName);
						}

						if (
							funcName !== depName && (
								!this._dependencies[funcName] ||
								this._dependencies[funcName].indexOf(depName) === -1
							)
						) {
							this._dependencies[funcName] = this._dependencies[funcName] || [];
							this._dependencies[funcName].push(depName);
						}
					}
				});

				if (!this._exports[v.name]) {
					const newName = this._prefixName(v.name);
					v.identifiers.forEach(id => {
						id.name = newName;
					});
					v.references.forEach(ref => {
						ref.identifier.name = newName;
					});
				} else if (this._exports[v.name] !== v.name) {
					// rename exported symbols from local name to exported name
					const newName = this._exports[v.name];
					v.identifiers.forEach(id => {
						id.name = newName;
					});
					v.references.forEach(ref => {
						ref.identifier.name = newName;
					});
				}
			});
		});
	}

	_transformIntoProperties() {
		const result = [];
		this._input.body.forEach(node => {
			switch (node.type) {
				case 'VariableDeclaration':
					node.declarations.forEach(v => {
						result.push({
							type: 'Property',
							key: {type: 'Identifier', name: v.id.name},
							value: node.init || {type: 'Literal', value: null},
						});
					});
					break;

				case 'FunctionDeclaration':
					result.push({
						type: 'Property',
						key: {type: 'Identifier', name: node.id.name},
						value: {
							type: 'FunctionExpression',
							params: node.params,
							body: node.body,
						},
					});
					break;

				default:
					throw new Error('unreachable');
			}
		});
		this._input.body = result;
	}

	_addDeps() {
		Object.keys(this._dependencies).forEach(name => {
			this._input.body.push({
				type: 'Property',
				key: {type: 'Identifier', name: `${name}__deps`},
				value: {
					type: 'ArrayExpression',
					elements: this._dependencies[name].map(dep => ({type: 'Literal', value: dep})),
				},
			});
		});
	}

	transform() {
		this._checkNodes();
		this._determineAndNormalizeExports();
		this._prefixLocalAndDetermineDeps();
		this._transformIntoProperties();
		this._addDeps();

		const output = parse('Object.assign(LibraryManager.library, {})');
		output.body[0].expression.arguments[1].properties = this._input.body;
		return output;
	}
}

export default function main(options = {}) {
	const localPrefix = options.localPrefix;
	delete options.localPrefix;

	return rollup(options).then(bundle => {
		const {code} = bundle.generate(Object.assign({}, options, {format: 'es'}));
		const ast = parse(code, {sourceType: 'module'});
		const transform = new EmscriptenTransform(ast, localPrefix);
		const outCode = generate(transform.transform());
		return {
			code: outCode,
			write(fileName) {
				return mkdirp(dirname(fileName)).then(() => writeFile(fileName, outCode));
			},
		};
	});
}
