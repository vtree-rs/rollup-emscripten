/* eslint-disable no-param-reassign */

import {rollup} from 'rollup';
import {parse} from 'acorn';
import {analyze} from 'escope';
import {generate} from 'escodegen';
import {writeFile} from 'js-utils-fs';
import mkdirp from 'mkdirp-promise';
import {dirname} from 'path';

// eslint-disable-next-line
// https://github.com/evanw/emscripten-library-generator/blob/5038b54bb8b5906572b09bc370f4b249776f2a3f/generator.js#L9-L19
function isPureValue(value) {
	return (
		!value ||
		value.type === 'Literal' ||
		value.type === 'ThisExpression' ||
		value.type === 'FunctionExpression' ||
		value.type === 'UnaryExpression' && isPureValue(value.argument) ||
		value.type === 'ArrayExpression' && value.elements.every(isPureValue) ||
		value.type === 'ObjectExpression' && value.properties.every(e => isPureValue(e.value)) ||
		(value.type === 'BinaryExpression' || value.type === 'LogicalExpression') &&
			isPureValue(value.left) && isPureValue(value.right)
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
			if (
				node.type !== 'FunctionDeclaration' &&
				node.type !== 'ExportNamedDeclaration' &&
				node.type !== 'VariableDeclaration'
			) {
				const nodeJson = JSON.stringify(node, undefined, '  ');
				throw new Error(`Unsupported top-level statement:\n${nodeJson}`);
			}
		});
	}

	_determineAndNormalizeVars() {
		const newBody = [];
		this._input.body.forEach(node => {
			if (node.type !== 'VariableDeclaration') {
				newBody.push(node);
				return;
			}

			node.declarations.forEach(decl => {
				const blockBody = [{
					type: 'VariableDeclaration',
					kind: 'var',
					declarations: [decl],
				}];

				if (!isPureValue(decl.init)) {
					// aid renamer by separating statements
					blockBody.push({
						type: 'ExpressionStatement',
						expression: {
							type: 'AssignmentExpression',
							left: {type: 'Identifier', name: decl.id.name},
							operator: '=',
							right: decl.init,
						},
					});
					decl.init = null;
				}

				decl.init = decl.init || {
					type: 'UnaryExpression',
					operator: 'void',
					argument: {
						type: 'Literal',
						value: 0,
					},
				};

				newBody.push({
					type: 'BlockStatement',
					body: blockBody,
				});
			});
		});
		this._input.body = newBody;
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
		return `${this._localPrefix}_${name}`;
	}

	_renameSymbols() {
		const scopes =
			analyze(this._input, {ecmaVersion: 6, sourceType: 'module'})
			.scopes;

		for (const scope of scopes) {
			if (scope.type === 'module') {
				this._scope = scope;
				break;
			}
		}

		this._scope.variables.forEach(v => {
			let refName = `_${v.name}`;
			if (this._exports[v.name] !== v.name) {
				if (this._exports[v.name]) {
					const newName = this._exports[v.name];
					delete this._exports[v.name];
					v.name = newName;
					this._exports[newName] = newName;
				} else {
					refName = this._prefixName(v.name);
					v.name = `$${refName}`;
				}
				v.identifiers.forEach(id => {
					id.name = v.name;
				});
			}
			v.references.forEach(ref => {
				if (v.identifiers.indexOf(ref.identifier) !== -1) return;
				ref.identifier.name = refName;
			});
		});
	}

	_determineDeps() {
		this._scope.childScopes.forEach(scope => {
			let id;
			const ignoreIds = [];

			if (scope.type === 'function') {
				id = scope.block.id;
			} else if (scope.type === 'block') {
				const {body} = scope.block;
				id = body[0].declarations[0].id;
				if (body.length === 2) {
					ignoreIds.push(body[1].expression.left);
				}
			}

			ignoreIds.push(id);

			if (!id) throw new Error('unreachable');

			const deps =
				scope.through
				.filter(ref => ref.resolved && ignoreIds.indexOf(ref.identifier) === -1)
				.map(ref => ref.resolved.name);

			if (deps.length) {
				this._dependencies[id.name] = deps;
			}
		});
	}

	_transformIntoProperties() {
		const result = [];
		this._input.body.forEach(node => {
			switch (node.type) {
				case 'BlockStatement': {
					if (node.body[0].type !== 'VariableDeclaration') {
						throw new Error('unreachable');
					}
					const decl = node.body[0].declarations[0];
					result.push({
						type: 'Property',
						key: decl.id,
						value: decl.init,
					});
					if (node.body.length === 2) {
						result.push({
							type: 'Property',
							key: {type: 'Identifier', name: `${decl.id.name}__postset`},
							value: {
								type: 'Literal',
								value: generate(node.body[1].expression),
							},
						});
					}
					break;
				}

				case 'FunctionDeclaration':
					result.push({
						type: 'Property',
						key: node.id,
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
		this._determineAndNormalizeVars();
		this._determineAndNormalizeExports();
		this._renameSymbols();
		this._determineDeps();
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
