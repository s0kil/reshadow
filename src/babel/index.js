const fs = require('fs');
const path = require('path');
const t = require('@babel/types');
const template = require('@babel/template').default;
const {addDefault} = require('@babel/helper-module-imports');
const {stripIndent} = require('common-tags');
const resolve = require('resolve');

const utils = require('../common/utils');

const buildClassName = template.expression(`
    NAME.styles["ELEMENT"]
`);

const toObjectExpression = obj =>
    t.objectExpression(
        Object.entries(obj).map(([key, value]) =>
            t.objectProperty(
                t.stringLiteral(key),
                t.templateLiteral(
                    [
                        t.templateElement({
                            raw: value,
                            cooked: value,
                        }),
                    ],
                    [],
                ),
            ),
        ),
    );

/**
 * Basic React.Fragment check
 * We can improve it by checking import aliases if needs
 */
const isReactFragment = node => {
    if (!node) return false;

    if (t.isJSXFragment(node)) return true;

    const [element] = node.arguments || [];

    if (t.isIdentifier(element)) return element.name === 'Fragment';

    if (t.isMemberExpression(element)) {
        return (
            element.object.name === 'React' &&
            element.property.name === 'Fragment'
        );
    }

    return false;
};

const defaultOptions = {
    postcss: false,
    elementFallback: true,
    files: false,
    inlineStyle: false,
};

module.exports = ({types: t}, options = {}) => {
    options = Object.assign({}, defaultOptions, options);

    let STYLED = new Set();
    let BINDINGS = {};
    let imports = {};
    let IMPORT = null;
    let cache = new Set();
    let FILE = null;

    let index;
    const hashById = id => Math.round(id * 100).toString(16);
    const getHash = () => hashById(++index);

    let filename;
    let fileHash;
    let cssIndex;
    const getFileHash = () => `${fileHash}_${hashById(++cssIndex)}`;

    let postcss;
    let cssFileRe = null;

    const pre = file => {
        ({filename} = file.opts);

        FILE = file;
        index = 1;
        cssIndex = 1;
        fileHash = utils.getFileHash(filename);
        STYLED = new Set();
        imports = {};
        IMPORT = null;
        cache = new Set();
        BINDINGS = file.scope.bindings;
    };

    const addImport = name => {
        if (!IMPORT) {
            IMPORT = addDefault(FILE.path, 'reshadow', {nameHint: 'styled'});
        }

        if (imports[name]) return imports[name];

        let localName;

        if (name === 'default') {
            localName = 'styled' in BINDINGS ? '_styled' : 'styled';

            IMPORT.specifiers.push(
                t.importDefaultSpecifier(t.identifier(localName)),
            );
        } else {
            localName = name in BINDINGS ? `_${name}` : name;

            IMPORT.specifiers.push(
                t.importSpecifier(t.identifier(localName), t.identifier(name)),
            );
        }

        imports[name] = localName;

        return localName;
    };

    const appendCode = ({quasi, name, hash}) => {
        const {expressions, quasis} = quasi;
        let code = '';

        quasis.forEach(({value}, i) => {
            code += value.raw;

            if (expressions[i]) {
                code += `var(--${hash}_${i})`;
            }
        });

        code = stripIndent(code);

        const append = t.taggedTemplateExpression(
            t.identifier(addImport('css')),
            t.templateLiteral(
                [
                    t.templateElement({
                        raw: code,
                        cooked: code,
                    }),
                ],
                [],
            ),
        );

        return append;
    };

    const prepareExpressions = (expressions, hash) => {
        if (options.inlineStyle) {
            return t.templateLiteral(
                expressions
                    .map((x, i) => {
                        const value = (i > 0 ? ';' : '') + `--${hash}_${i}:`;

                        return t.templateElement({
                            raw: value,
                            cooked: value,
                        });
                    })
                    .concat(
                        t.templateElement(
                            {
                                raw: ';',
                                cooked: ';',
                            },
                            true,
                        ),
                    ),
                expressions,
            );
        }

        return t.objectExpression(
            expressions.map((x, i) =>
                t.objectProperty(t.stringLiteral(`--${hash}_${i}`), x),
            ),
        );
    };

    const traverseStyled = (p, {quasi} = {}) => {
        const {callee} = p.node;
        const {name} = callee.callee || callee;

        const hash = getHash();
        const hashName = `${name}_${hash}`;

        const globalStyles = [];
        const localStyles = [t.identifier(hashName)];

        for (let arg of callee.arguments || []) {
            if (!t.isIdentifier(arg)) {
                localStyles.push(arg);
                continue;
            }

            (arg.name in BINDINGS ? globalStyles : localStyles).push(arg);
        }

        p.node.callee = t.identifier(name);

        const variables =
            quasi &&
            quasi.expressions.length &&
            prepareExpressions(quasi.expressions, hash);

        const stylesSet = t.sequenceExpression([
            t.callExpression(t.identifier(addImport('set')), [
                t.arrayExpression(localStyles),
            ]),
            p.node.arguments[0],
        ]);

        p.node.arguments = [stylesSet];

        let path = p;

        while (path.parentPath.type !== 'Program') {
            path = path.parentPath;
        }

        path.insertBefore(
            t.variableDeclaration('const', [
                t.variableDeclarator(
                    t.identifier(hashName),
                    t.callExpression(t.identifier(addImport('create')), [
                        t.arrayExpression(
                            globalStyles.concat(
                                quasi ? appendCode({quasi, name, hash}) : [],
                            ),
                        ),
                    ]),
                ),
            ]),
        );

        const getElementName = node => {
            if (t.isJSXNamespacedName(node))
                return [
                    getElementName(node.namespace),
                    getElementName(node.name),
                ].join(':');

            if (t.isJSXIdentifier(node)) return node.name;

            if (t.isJSXMemberExpression(node)) {
                return [
                    getElementName(node.object),
                    getElementName(node.property),
                ].join('.');
            }
        };

        let depth = 0;

        p.traverse({
            JSXElement(p) {
                const {node} = p;

                if (isReactFragment(node) || cache.has(node)) return;

                cache.add(node);

                if (variables && depth === 0) {
                    for (let x of p.container) {
                        if (!t.isJSXElement(x)) continue;

                        x.openingElement.attributes.push(
                            t.jSXAttribute(
                                t.JSXIdentifier('__style__'),
                                t.JSXExpressionContainer(variables),
                            ),
                        );
                    }
                }

                depth++;

                const {openingElement} = node;

                let elementName = getElementName(openingElement.name);

                elementName = elementName.replace(/^use\./, 'use:');

                let isElement = true;

                if (elementName.startsWith('use:')) {
                    elementName = elementName.replace('use:', 'use--');
                    openingElement.name = t.JSXIdentifier('div');
                } else if (utils.isCustomElement(elementName)) {
                    if (options.elementFallback) {
                        openingElement.name = t.JSXIdentifier('div');
                    }
                } else if (!/[^A-Z]\w+/.test(elementName)) {
                    isElement = false;
                }

                const spreads = [];

                if (openingElement.attributes.length > 0) {
                    let props = [];
                    const uses = [];
                    let useAttr = null;

                    const getProp = (name, valueNode) => {
                        const key = /[$0-9a-z_]/i.test(name)
                            ? t.identifier(name)
                            : t.stringLiteral(name);

                        const value = t.isJSXExpressionContainer(valueNode)
                            ? valueNode.expression
                            : valueNode;

                        return t.objectProperty(
                            key,
                            value || t.booleanLiteral(true),
                        );
                    };

                    openingElement.attributes.forEach((attr, i) => {
                        if (t.isJSXSpreadAttribute(attr)) {
                            if (
                                t.isCallExpression(attr.argument) &&
                                attr.argument.callee.name === 'use'
                            ) {
                                useAttr = attr;
                            } else {
                                if (props.length) {
                                    spreads.push(t.objectExpression(props));
                                    props = [];
                                }

                                spreads.push(attr.argument);
                            }

                            return;
                        }

                        if (
                            isElement &&
                            t.isJSXIdentifier(attr.name) &&
                            attr.name.name === 'as'
                        ) {
                            openingElement.name.name = attr.value.value;
                        } else if (
                            t.isJSXNamespacedName(attr.name) &&
                            attr.name.namespace.name === 'use'
                        ) {
                            const name = attr.name.name.name;

                            uses.push(getProp(name, attr.value));
                        } else {
                            const name = getElementName(attr.name);

                            props.push(getProp(name, attr.value));
                        }
                    });

                    if (props.length > 0) {
                        spreads.push(t.objectExpression(props));
                    }

                    if (useAttr || uses.length > 0) {
                        if (!useAttr) {
                            const USE = addImport('use');

                            useAttr = t.JSXSpreadAttribute(
                                t.callExpression(t.identifier(USE), [
                                    t.objectExpression([]),
                                ]),
                            );
                        }

                        useAttr.argument.arguments[0].properties.push(...uses);

                        spreads.push(useAttr.argument);
                    }
                }

                if (spreads.length > 0) {
                    openingElement.attributes = [
                        t.JSXSpreadAttribute(
                            t.callExpression(t.identifier(addImport('map')), [
                                t.stringLiteral(elementName),
                                ...spreads,
                            ]),
                        ),
                    ];
                } else {
                    openingElement.attributes = [
                        t.JSXAttribute(
                            t.JSXIdentifier('className'),
                            t.JSXExpressionContainer(
                                buildClassName({
                                    NAME: name,
                                    ELEMENT: t.stringLiteral(
                                        `__${elementName}`,
                                    ),
                                }),
                            ),
                        ),
                    ];
                }
            },
        });
    };

    const traverseTaggedTemplate = p => {
        const {callee} = p.node;

        const {tag, quasi} = callee;

        if (!(isStyledExpression(tag) || STYLED.has(tag.name))) return;

        p.node.callee = tag;

        return traverseStyled(p, {quasi});
    };

    const isStyledExpression = node => {
        if (t.isCallExpression(node)) return STYLED.has(node.callee.name);

        return false;
    };

    const visitor = {
        CallExpression(p) {
            if (STYLED.size === 0) return;

            const {callee} = p.node;

            if (t.isTaggedTemplateExpression(callee)) {
                traverseTaggedTemplate(p);
                return;
            }

            if (isStyledExpression(callee)) {
                traverseStyled(p);
            }
        },
    };

    visitor.TaggedTemplateExpression = p => {
        let {node} = p;
        const {quasi, tag} = node;

        if (tag.name !== imports.css) {
            return;
        }

        const hash = getFileHash();

        p.replaceWith(
            t.callExpression(t.identifier(addImport('__css__')), [
                quasi,
                t.stringLiteral(hash),
            ]),
        );

        ({node} = p);

        if (!postcss) return;

        const {raw} = quasi.quasis[0].value;

        const result = postcss.process(raw, {from: filename});
        const code = result.code;
        const tokens = toObjectExpression(result.tokens);

        node.arguments[0] = t.templateLiteral(
            [
                t.templateElement({
                    raw: code,
                    cooked: code,
                }),
            ],
            [],
        );

        p.replaceWith(t.sequenceExpression([node, tokens]));
    };

    return {
        pre,
        visitor: {
            Program: {
                enter(path, state) {
                    // babel 6 compatibility
                    Object.assign(options, state.opts);
                    if (options.postcss && !postcss) {
                        postcss = require('./postcss')(options.postcss);
                    }
                    if (options.files && !cssFileRe) {
                        cssFileRe = new RegExp(options.files);
                    }

                    pre(state.file);
                },
            },
            ImportDeclaration(p) {
                const {source, specifiers} = p.node;

                if (cssFileRe && cssFileRe.test(source.value)) {
                    const file = resolve.sync(source.value, {
                        basedir: path.dirname(filename),
                    });

                    const code = fs.readFileSync(file);

                    const append = t.taggedTemplateExpression(
                        t.identifier(addImport('css')),
                        t.templateLiteral(
                            [
                                t.templateElement({
                                    raw: code,
                                    cooked: code,
                                }),
                            ],
                            [],
                        ),
                    );

                    p.replaceWith(
                        t.variableDeclaration('const', [
                            t.variableDeclarator(
                                t.objectPattern(
                                    specifiers.map(spec => {
                                        if (t.isImportDefaultSpecifier(spec))
                                            return t.restElement(
                                                t.identifier(spec.local.name),
                                            );

                                        return t.objectProperty(
                                            t.identifier(spec.imported.name),
                                            t.identifier(spec.local.name),
                                            false,
                                            spec.imported.name ===
                                                spec.local.name,
                                        );
                                    }),
                                ),
                                append,
                            ),
                        ]),
                    );

                    return;
                }

                let SOURCE = options.source || 'reshadow';

                if (source.value !== SOURCE) return;

                if (source.value !== 'reshadow') {
                    source.value = 'reshadow';
                }

                IMPORT = p.node;

                for (let spec of specifiers) {
                    if (t.isImportDefaultSpecifier(spec)) {
                        const name = spec.local.name;
                        STYLED.add(name);
                        imports.default = name;
                    } else {
                        if (spec.imported.name === 'css') {
                            imports.css = spec.local.name;
                        } else if (spec.imported.name === 'use') {
                            imports.use = spec.local.name;
                        }
                    }
                }
            },
            ...visitor,
        },
    };
};