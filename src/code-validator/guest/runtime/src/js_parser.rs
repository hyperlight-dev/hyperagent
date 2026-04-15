/*
Copyright 2026  The Hyperlight Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

//! nom-based JavaScript expression parser for validation.
//!
//! Provides parsers for:
//! - Simple assignments: `const x = func()`
//! - Method calls: `obj.method()`
//! - Chained calls: `obj.method1().method2()`
//! - Function calls: `func(arg1, arg2)`
//! - Import statements: `import { x } from "module"`
//! - Ternary expressions: `cond ? expr1 : expr2`
//!
//! These are targeted parsers for type tracking, not a full JS parser.

extern crate alloc;

use alloc::string::String;
use alloc::vec::Vec;
use nom::{
    IResult, Parser,
    branch::alt,
    bytes::complete::{tag, take_while, take_while1},
    character::complete::{char, multispace0},
    combinator::recognize,
    multi::{many0, separated_list0},
    sequence::{delimited, pair},
};

// ============================================================================
// Basic Parsers
// ============================================================================

/// Parse a JavaScript identifier (variable/function name).
/// Matches: [a-zA-Z_$][a-zA-Z0-9_$]*
pub fn identifier(input: &str) -> IResult<&str, &str> {
    recognize(pair(
        take_while1(|c: char| c.is_alphabetic() || c == '_' || c == '$'),
        take_while(|c: char| c.is_alphanumeric() || c == '_' || c == '$'),
    ))
    .parse(input)
}

/// Skip whitespace (spaces, tabs, newlines).
fn ws(input: &str) -> IResult<&str, &str> {
    multispace0(input)
}

/// Parse a string literal (single or double quoted).
/// Returns the content without quotes.
pub fn string_literal(input: &str) -> IResult<&str, &str> {
    alt((
        delimited(char('"'), take_while(|c| c != '"'), char('"')),
        delimited(char('\''), take_while(|c| c != '\''), char('\'')),
    ))
    .parse(input)
}

// ============================================================================
// Assignment Parsing
// ============================================================================

/// Result of parsing a simple assignment.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleAssignment<'a> {
    pub var_name: &'a str,
    pub func_name: &'a str,
}

/// Parse a simple assignment: `varName = funcName(`
/// Used for type tracking (e.g., `const pres = createPresentation()`)
pub fn simple_assignment(input: &str) -> IResult<&str, SimpleAssignment<'_>> {
    let (input, _) = ws(input)?;
    let (input, var_name) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = char('=')(input)?;
    let (input, _) = ws(input)?;
    let (input, func_name) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = char('(')(input)?;

    Ok((
        input,
        SimpleAssignment {
            var_name,
            func_name,
        },
    ))
}

/// Parse a variable declaration with assignment.
/// Matches: `const|let|var varName = funcName(`
pub fn var_decl_assignment(input: &str) -> IResult<&str, SimpleAssignment<'_>> {
    let (input, _) = ws(input)?;
    let (input, _) = alt((tag("const"), tag("let"), tag("var"))).parse(input)?;
    let (input, _) = take_while1(|c: char| c.is_whitespace())(input)?;
    simple_assignment(input)
}

// ============================================================================
// Method Call Parsing
// ============================================================================

/// A single method call in a chain.
#[derive(Debug, Clone, PartialEq)]
pub struct MethodCall<'a> {
    pub method: &'a str,
}

/// Result of parsing a method call expression.
#[derive(Debug, Clone, PartialEq)]
pub struct MethodCallExpr<'a> {
    /// The initial object (variable name).
    pub object: &'a str,
    /// Chain of method calls.
    pub chain: Vec<MethodCall<'a>>,
}

/// Parse arguments inside parentheses (we don't care about the content, just balance).
fn skip_args(input: &str) -> IResult<&str, ()> {
    let (input, _) = char('(')(input)?;
    let mut depth = 1;
    let mut remaining = input;

    for (i, c) in input.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    remaining = &input[i + 1..];
                    break;
                }
            }
            _ => {}
        }
    }

    if depth != 0 {
        return Err(nom::Err::Error(nom::error::Error::new(
            input,
            nom::error::ErrorKind::Char,
        )));
    }

    Ok((remaining, ()))
}

/// Parse a single method call: `.methodName(args)`
fn method_call_segment(input: &str) -> IResult<&str, MethodCall<'_>> {
    let (input, _) = ws(input)?;
    let (input, _) = char('.')(input)?;
    let (input, _) = ws(input)?;
    let (input, method) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = skip_args(input)?;

    Ok((input, MethodCall { method }))
}

/// Parse a chained method call expression: `obj.method1().method2().method3()`
pub fn chained_method_call(input: &str) -> IResult<&str, MethodCallExpr<'_>> {
    let (input, _) = ws(input)?;
    let (input, object) = identifier(input)?;
    let (input, chain) = many0(method_call_segment).parse(input)?;

    if chain.is_empty() {
        return Err(nom::Err::Error(nom::error::Error::new(
            input,
            nom::error::ErrorKind::Many0,
        )));
    }

    Ok((input, MethodCallExpr { object, chain }))
}

/// Parse a variable declaration with chained method call.
/// Matches: `const|let|var varName = obj.method1().method2()`
pub fn var_decl_chained_call(input: &str) -> IResult<&str, (&str, MethodCallExpr<'_>)> {
    let (input, _) = ws(input)?;
    let (input, _) = alt((tag("const"), tag("let"), tag("var"))).parse(input)?;
    let (input, _) = take_while1(|c: char| c.is_whitespace())(input)?;
    let (input, var_name) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = char('=')(input)?;
    let (input, _) = ws(input)?;
    let (input, expr) = chained_method_call(input)?;

    Ok((input, (var_name, expr)))
}

// ============================================================================
// Function Call Parsing
// ============================================================================

/// Result of parsing a function call.
#[derive(Debug, Clone, PartialEq)]
pub struct FunctionCall<'a> {
    pub func_name: &'a str,
    pub arg_count: usize,
}

/// Count arguments by tracking parenthesis depth and commas.
fn count_args(input: &str) -> IResult<&str, usize> {
    let (input, _) = char('(')(input)?;

    let mut depth = 1;
    let mut comma_count = 0;
    let mut has_content = false;
    let mut end_pos = 0;

    for (i, c) in input.char_indices() {
        match c {
            '(' | '[' | '{' => {
                depth += 1;
                has_content = true;
            }
            ')' | ']' | '}' => {
                depth -= 1;
                if depth == 0 {
                    end_pos = i + 1;
                    break;
                }
            }
            ',' if depth == 1 => comma_count += 1,
            c if !c.is_whitespace() => has_content = true,
            _ => {}
        }
    }

    if depth != 0 {
        return Err(nom::Err::Error(nom::error::Error::new(
            input,
            nom::error::ErrorKind::Char,
        )));
    }

    let remaining = &input[end_pos..];
    let count = if !has_content { 0 } else { comma_count + 1 };

    Ok((remaining, count))
}

/// Parse a function call: `funcName(args)`
/// Does not match method calls (preceded by `.`)
pub fn function_call(input: &str) -> IResult<&str, FunctionCall<'_>> {
    let (input, _) = ws(input)?;
    let (input, func_name) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, arg_count) = count_args(input)?;

    Ok((
        input,
        FunctionCall {
            func_name,
            arg_count,
        },
    ))
}

// ============================================================================
// Import Parsing
// ============================================================================

/// Result of parsing an import statement.
#[derive(Debug, Clone, PartialEq)]
pub struct ImportStatement<'a> {
    pub specifier: &'a str,
    pub names: Vec<&'a str>,
}

/// Parse: `{ name1, name2, ... }`
fn named_imports(input: &str) -> IResult<&str, Vec<&str>> {
    let (input, _) = char('{')(input)?;
    let (input, _) = ws(input)?;
    let (input, names) = separated_list0(
        |i| {
            let (i, _) = ws(i)?;
            let (i, _) = char(',')(i)?;
            ws(i)
        },
        // Handle `name` or `name as alias` - we only care about the imported name
        alt((
            // `original as alias` -> take original
            |i| {
                let (i, name) = identifier(i)?;
                let (i, _) = ws(i)?;
                let (i, _) = tag("as")(i)?;
                let (i, _) = ws(i)?;
                let (i, _) = identifier(i)?;
                Ok((i, name))
            },
            // `name` -> take name
            identifier,
        )),
    )
    .parse(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = char('}')(input)?;
    Ok((input, names))
}

/// Parse an import statement.
/// Matches:
/// - `import { a, b } from "module"`
/// - `import * as name from "module"`
/// - `import name from "module"`
/// - `import "module"` (side-effect)
pub fn import_statement(input: &str) -> IResult<&str, ImportStatement<'_>> {
    let (input, _) = ws(input)?;
    let (input, _) = tag("import")(input)?;
    let (input, _) = take_while1(|c: char| c.is_whitespace())(input)?;

    // Try different import forms
    alt((
        // Side-effect import: import "module"
        |i| {
            let (i, specifier) = string_literal(i)?;
            Ok((
                i,
                ImportStatement {
                    specifier,
                    names: Vec::new(),
                },
            ))
        },
        // Named imports: import { a, b } from "module"
        |i| {
            let (i, names) = named_imports(i)?;
            let (i, _) = ws(i)?;
            let (i, _) = tag("from")(i)?;
            let (i, _) = ws(i)?;
            let (i, specifier) = string_literal(i)?;
            Ok((i, ImportStatement { specifier, names }))
        },
        // Namespace import: import * as name from "module"
        |i| {
            let (i, _) = char('*')(i)?;
            let (i, _) = ws(i)?;
            let (i, _) = tag("as")(i)?;
            let (i, _) = ws(i)?;
            let (i, _) = identifier(i)?;
            let (i, _) = ws(i)?;
            let (i, _) = tag("from")(i)?;
            let (i, _) = ws(i)?;
            let (i, specifier) = string_literal(i)?;
            Ok((
                i,
                ImportStatement {
                    specifier,
                    names: Vec::new(),
                },
            ))
        },
        // Default import: import name from "module"
        |i| {
            let (i, name) = identifier(i)?;
            let (i, _) = ws(i)?;
            let (i, _) = tag("from")(i)?;
            let (i, _) = ws(i)?;
            let (i, specifier) = string_literal(i)?;
            Ok((
                i,
                ImportStatement {
                    specifier,
                    names: alloc::vec![name],
                },
            ))
        },
    ))
    .parse(input)
}

// ============================================================================
// Ternary Expression Parsing (Phase 4.5.4)
// ============================================================================

/// Result of parsing a ternary assignment.
#[derive(Debug, Clone, PartialEq)]
pub struct TernaryAssignment<'a> {
    pub var_name: &'a str,
    /// True branch expression (simplified - just capture if it's a function call)
    pub true_expr: Option<&'a str>,
    /// False branch expression
    pub false_expr: Option<&'a str>,
    /// Whether either branch is null/undefined
    pub is_nullable: bool,
}

/// Parse until we hit `?` at depth 0 (skipping nested ternaries).
fn take_until_question(input: &str) -> IResult<&str, &str> {
    let mut depth = 0;
    for (i, c) in input.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            '?' if depth == 0 => {
                return Ok((&input[i..], &input[..i]));
            }
            _ => {}
        }
    }
    Err(nom::Err::Error(nom::error::Error::new(
        input,
        nom::error::ErrorKind::TakeUntil,
    )))
}

/// Parse until we hit `:` at depth 0.
fn take_until_colon(input: &str) -> IResult<&str, &str> {
    let mut depth = 0;
    for (i, c) in input.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            ':' if depth == 0 => {
                return Ok((&input[i..], &input[..i]));
            }
            _ => {}
        }
    }
    Err(nom::Err::Error(nom::error::Error::new(
        input,
        nom::error::ErrorKind::TakeUntil,
    )))
}

/// Check if an expression is null or undefined.
fn is_null_or_undefined(expr: &str) -> bool {
    let trimmed = expr.trim();
    trimmed == "null" || trimmed == "undefined"
}

/// Extract function name from a simple call expression like `createPresentation()`.
fn extract_func_name(expr: &str) -> Option<&str> {
    let trimmed = expr.trim();
    // Look for identifier followed by (
    if let Ok((_, call)) = function_call(trimmed) {
        Some(call.func_name)
    } else {
        None
    }
}

/// Parse a ternary assignment: `const x = cond ? expr1 : expr2`
pub fn ternary_assignment(input: &str) -> IResult<&str, TernaryAssignment<'_>> {
    let (input, _) = ws(input)?;
    let (input, _) = alt((tag("const"), tag("let"), tag("var"))).parse(input)?;
    let (input, _) = take_while1(|c: char| c.is_whitespace())(input)?;
    let (input, var_name) = identifier(input)?;
    let (input, _) = ws(input)?;
    let (input, _) = char('=')(input)?;
    let (input, _) = ws(input)?;

    // Parse condition (everything until ?)
    let (input, _condition) = take_until_question(input)?;
    let (input, _) = char('?')(input)?;
    let (input, _) = ws(input)?;

    // Parse true branch (everything until :)
    let (input, true_branch) = take_until_colon(input)?;
    let (input, _) = char(':')(input)?;
    let (input, _) = ws(input)?;

    // Parse false branch (rest of line, stopping at ; or newline)
    let false_branch = input.split([';', '\n']).next().unwrap_or(input);

    let true_is_null = is_null_or_undefined(true_branch);
    let false_is_null = is_null_or_undefined(false_branch);

    Ok((
        "",
        TernaryAssignment {
            var_name,
            true_expr: extract_func_name(true_branch),
            false_expr: extract_func_name(false_branch),
            is_nullable: true_is_null || false_is_null,
        },
    ))
}

// ============================================================================
// Line-Level Extraction (for scanning source files)
// ============================================================================

/// Extract all import specifiers from source code.
pub fn extract_all_imports(source: &str) -> Vec<String> {
    let mut imports = Vec::new();

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import")
            && let Ok((_, stmt)) = import_statement(trimmed)
            && !imports.iter().any(|s: &String| s == stmt.specifier)
        {
            imports.push(String::from(stmt.specifier));
        }
        // Also check for `from "..."` pattern on continuation lines.
        // Only match when `from` is at the start of the line or after `}`
        // (e.g. `  } from "ha:pptx"` or `  from "ha:pptx"`).
        // This avoids false positives from prose inside string literals
        // like: `"an AI that builds documents from 'impressive demo'"`
        if (trimmed.starts_with("from ")
            || trimmed.contains("} from ")
            || trimmed.contains("}from "))
            && let Some(from_pos) = trimmed.find("from ")
        {
            let rest = &trimmed[from_pos + 5..];
            if let Ok((_, specifier)) = string_literal(rest.trim())
                && !imports.iter().any(|s: &String| s == specifier)
            {
                imports.push(String::from(specifier));
            }
        }
    }

    imports
}

/// Named import with its module specifier.
#[derive(Debug, Clone)]
pub struct NamedImport {
    /// The module specifier (e.g., "ha:shared-state")
    pub module: String,
    /// The named imports (e.g., ["set", "get"])
    pub names: Vec<String>,
}

/// Extract all named imports from source code.
/// Returns module specifier → list of imported names.
pub fn extract_all_named_imports(source: &str) -> Vec<NamedImport> {
    let mut imports = Vec::new();

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import")
            && let Ok((_, stmt)) = import_statement(trimmed)
        {
            // Only track named imports (not namespace or default)
            if !stmt.names.is_empty() {
                imports.push(NamedImport {
                    module: String::from(stmt.specifier),
                    names: stmt.names.iter().map(|s| String::from(*s)).collect(),
                });
            }
        }
    }

    imports
}

/// Namespace import information.
/// For `import * as pptx from "ha:pptx"`, stores ("pptx", "ha:pptx").
#[derive(Debug, Clone)]
pub struct NamespaceImport {
    /// The local alias (e.g., "pptx")
    pub alias: String,
    /// The module specifier (e.g., "ha:pptx")
    pub module: String,
}

/// Extract all namespace imports from source code.
/// Matches: `import * as alias from "module"`
pub fn extract_namespace_imports(source: &str) -> Vec<NamespaceImport> {
    let mut imports = Vec::new();

    for line in source.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("import") {
            continue;
        }
        // Look for "* as" pattern
        if let Some(star_pos) = trimmed.find("* as") {
            let rest = &trimmed[star_pos + 4..].trim_start();
            // Extract alias (identifier before "from")
            let mut alias_end = 0;
            for (i, c) in rest.char_indices() {
                if c.is_alphanumeric() || c == '_' || c == '$' {
                    alias_end = i + 1;
                } else {
                    break;
                }
            }
            if alias_end > 0 {
                let alias = &rest[..alias_end];
                // Find the module specifier
                if let Some(from_pos) = rest.find("from") {
                    let after_from = rest[from_pos + 4..].trim_start();
                    if let Ok((_, module)) = string_literal(after_from) {
                        imports.push(NamespaceImport {
                            alias: String::from(alias),
                            module: String::from(module),
                        });
                    }
                }
            }
        }
    }

    imports
}

/// Information about a method call found in source.
#[derive(Debug, Clone)]
pub struct MethodCallInfo {
    pub object: String,
    pub method: String,
    pub line: u32,
}

/// Information about a function call found in source.
#[derive(Debug, Clone)]
pub struct FunctionCallInfo {
    pub func_name: String,
    pub arg_count: usize,
    pub line: u32,
}

/// Information about an assignment found in source.
#[derive(Debug, Clone)]
pub struct AssignmentInfo {
    pub var_name: String,
    /// The function that was called (for simple calls).
    pub func_name: Option<String>,
    /// For chained calls, the full chain of method names.
    pub method_chain: Vec<String>,
    /// The initial object (for chained calls).
    pub initial_object: Option<String>,
    /// Whether the variable could be null (ternary with null branch).
    pub is_nullable: bool,
    pub line: u32,
}

impl AssignmentInfo {
    /// Get the final method in the chain (for backwards compatibility).
    pub fn final_method(&self) -> Option<&str> {
        self.method_chain.last().map(|s| s.as_str())
    }
}

/// Information about a destructuring assignment.
/// Example: `const { slideCount, metadata } = pres`
#[derive(Debug, Clone)]
pub struct DestructuringInfo {
    /// The variable names extracted from destructuring.
    pub extracted_vars: Vec<String>,
    /// The source object (RHS of =).
    pub source_object: String,
    /// Whether it's object destructuring ({}) or array destructuring ([]).
    pub is_object: bool,
    /// Line number (1-indexed).
    pub line: u32,
}

/// Extract all destructuring assignments from source code.
/// Handles: `const { a, b } = obj` and `const [x, y] = arr`
pub fn extract_all_destructuring(source: &str) -> Vec<DestructuringInfo> {
    let mut results = Vec::new();

    for (line_num, line) in source.lines().enumerate() {
        let trimmed = line.trim();

        // Must be a variable declaration
        if !trimmed.starts_with("const ")
            && !trimmed.starts_with("let ")
            && !trimmed.starts_with("var ")
        {
            continue;
        }

        // Skip keyword to get pattern
        let after_keyword = if let Some(rest) = trimmed.strip_prefix("const ") {
            rest.trim()
        } else if let Some(rest) = trimmed.strip_prefix("let ") {
            rest.trim()
        } else if let Some(rest) = trimmed.strip_prefix("var ") {
            rest.trim()
        } else {
            continue;
        };

        // Check for object destructuring: { ... } =
        if after_keyword.starts_with('{') {
            if let Some(info) = parse_object_destructuring(after_keyword, line_num as u32 + 1) {
                results.push(info);
            }
        }
        // Check for array destructuring: [ ... ] =
        else if after_keyword.starts_with('[')
            && let Some(info) = parse_array_destructuring(after_keyword, line_num as u32 + 1)
        {
            results.push(info);
        }
    }

    results
}

/// Parse object destructuring: `{ a, b, c: d } = obj`
fn parse_object_destructuring(input: &str, line: u32) -> Option<DestructuringInfo> {
    // Find matching }
    let close_brace = find_matching_brace(input, '{')?;
    let pattern = &input[1..close_brace].trim();

    // Find = after the }
    let after_brace = &input[close_brace + 1..].trim();
    let eq_pos = after_brace.find('=')?;
    let source_str = after_brace[eq_pos + 1..].trim();

    // Extract source object (stop at ; or end of line)
    let source_end = source_str.find(';').unwrap_or(source_str.len());
    let source_object = source_str[..source_end].trim();

    // Skip if source looks like a function call (has parens)
    // We can't track types from arbitrary expressions
    if source_object.contains('(') {
        return None;
    }

    // Extract variable names from pattern
    let extracted_vars = extract_destructure_names(pattern);
    if extracted_vars.is_empty() {
        return None;
    }

    Some(DestructuringInfo {
        extracted_vars,
        source_object: String::from(source_object),
        is_object: true,
        line,
    })
}

/// Parse array destructuring: `[a, b, c] = arr`
fn parse_array_destructuring(input: &str, line: u32) -> Option<DestructuringInfo> {
    // Find matching ]
    let close_bracket = find_matching_brace(input, '[')?;
    let pattern = &input[1..close_bracket].trim();

    // Find = after the ]
    let after_bracket = &input[close_bracket + 1..].trim();
    let eq_pos = after_bracket.find('=')?;
    let source_str = after_bracket[eq_pos + 1..].trim();

    // Extract source object (stop at ; or end of line)
    let source_end = source_str.find(';').unwrap_or(source_str.len());
    let source_object = source_str[..source_end].trim();

    // Skip if source looks like a function call
    if source_object.contains('(') {
        return None;
    }

    // Extract variable names from pattern (simpler for arrays - just split by comma)
    let mut extracted_vars = Vec::new();
    for part in pattern.split(',') {
        let name = part.trim();
        // Skip rest elements for now
        if name.starts_with("...") {
            continue;
        }
        if !name.is_empty()
            && name
                .chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_')
        {
            extracted_vars.push(String::from(name));
        }
    }

    if extracted_vars.is_empty() {
        return None;
    }

    Some(DestructuringInfo {
        extracted_vars,
        source_object: String::from(source_object),
        is_object: false,
        line,
    })
}

/// Find matching closing brace/bracket.
fn find_matching_brace(input: &str, open: char) -> Option<usize> {
    let close = match open {
        '{' => '}',
        '[' => ']',
        '(' => ')',
        _ => return None,
    };

    let mut depth = 0;
    for (i, c) in input.char_indices() {
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(i);
            }
        }
    }
    None
}

/// Extract variable names from destructuring pattern.
/// Handles: `{ a, b, c: d }` -> [a, b, d]
fn extract_destructure_names(pattern: &str) -> Vec<String> {
    let mut names = Vec::new();

    for part in pattern.split(',') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Handle renaming: `originalName: newName`
        if let Some(colon_pos) = trimmed.find(':') {
            let new_name = trimmed[colon_pos + 1..].trim();
            // Skip if it's a nested destructure
            if !new_name.starts_with('{')
                && !new_name.starts_with('[')
                && !new_name.is_empty()
                && new_name
                    .chars()
                    .next()
                    .is_some_and(|c| c.is_alphabetic() || c == '_')
            {
                names.push(String::from(new_name));
            }
        } else {
            // Simple name
            if trimmed
                .chars()
                .next()
                .is_some_and(|c| c.is_alphabetic() || c == '_')
            {
                // Handle default values: `name = default`
                let name = if let Some(eq_pos) = trimmed.find('=') {
                    trimmed[..eq_pos].trim()
                } else {
                    trimmed
                };
                if !name.is_empty() {
                    names.push(String::from(name));
                }
            }
        }
    }

    names
}

/// JavaScript built-in methods to skip during validation.
///
/// IMPORTANT: This list must match what hyperlight-js-runtime actually provides.
/// Run `npx tsx scripts/extract-hyperlight-builtins.ts` to regenerate.
///
/// Includes: QuickJS standard library + hyperlight-js custom methods.
/// Excludes: Browser/Node APIs not in hyperlight-js (setTimeout, fetch, etc.)
const BUILTIN_METHODS: &[&str] = &[
    // Array methods
    "push",
    "pop",
    "shift",
    "unshift",
    "slice",
    "splice",
    "concat",
    "join",
    "map",
    "filter",
    "reduce",
    "reduceRight",
    "forEach",
    "find",
    "findIndex",
    "includes",
    "indexOf",
    "lastIndexOf",
    "every",
    "some",
    "flat",
    "flatMap",
    "fill",
    "sort",
    "reverse",
    "at",
    "entries",
    "keys",
    "values",
    "copyWithin",
    "toSorted",
    "toReversed",
    "toSpliced",
    "with",
    "subarray",
    "set",
    // String methods
    "split",
    "trim",
    "trimStart",
    "trimEnd",
    "toLowerCase",
    "toUpperCase",
    "substring",
    "substr",
    "replace",
    "replaceAll",
    "match",
    "matchAll",
    "search",
    "charAt",
    "charCodeAt",
    "codePointAt",
    "startsWith",
    "endsWith",
    "padStart",
    "padEnd",
    "repeat",
    "normalize",
    "localeCompare",
    // Object methods
    "hasOwnProperty",
    "toString",
    "valueOf",
    "toJSON",
    "toLocaleString",
    "assign",
    "freeze",
    "seal",
    "create",
    "defineProperty",
    "defineProperties",
    "getOwnPropertyDescriptor",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "getPrototypeOf",
    "setPrototypeOf",
    "is",
    "fromEntries",
    // Promise methods
    "then",
    "catch",
    "finally",
    "all",
    "allSettled",
    "any",
    "race",
    "resolve",
    "reject",
    // JSON
    "parse",
    "stringify",
    // Console - ONLY log is available in hyperlight-js (NOT warn/error/info/debug/trace/table)
    "log",
    // Math
    "abs",
    "ceil",
    "floor",
    "round",
    "max",
    "min",
    "random",
    "sqrt",
    "pow",
    "sign",
    "trunc",
    "log",
    "log10",
    "log2",
    "exp",
    "sin",
    "cos",
    "tan",
    "asin",
    "acos",
    "atan",
    "atan2",
    "sinh",
    "cosh",
    "tanh",
    "hypot",
    "cbrt",
    // Map/Set
    "get",
    "has",
    "delete",
    "clear",
    "add",
    // Date
    "getTime",
    "getFullYear",
    "getMonth",
    "getDate",
    "getDay",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "setTime",
    "setFullYear",
    "setMonth",
    "setDate",
    "setHours",
    "setMinutes",
    "setSeconds",
    "setMilliseconds",
    "toISOString",
    "toDateString",
    "toTimeString",
    // RegExp
    "test",
    "exec",
    // DataView
    "getInt8",
    "getUint8",
    "getInt16",
    "getUint16",
    "getInt32",
    "getUint32",
    "getFloat32",
    "getFloat64",
    "getBigInt64",
    "getBigUint64",
    "setInt8",
    "setUint8",
    "setInt16",
    "setUint16",
    "setInt32",
    "setUint32",
    "setFloat32",
    "setFloat64",
    "setBigInt64",
    "setBigUint64",
    // Hyperlight-specific: crypto.Hmac methods
    "update",
    "finalize",
    "digest",
    // Hyperlight-specific: String.bytesFrom
    "bytesFrom",
];

/// JavaScript built-in functions/constructors to skip during validation.
///
/// IMPORTANT: This list must match what hyperlight-js-runtime actually provides.
/// Run `npx tsx scripts/extract-hyperlight-builtins.ts` to regenerate.
///
/// Includes: QuickJS standard library + hyperlight-js custom globals.
/// Excludes: Browser/Node APIs not in hyperlight-js (setTimeout, fetch, etc.)
const BUILTIN_FUNCTIONS: &[&str] = &[
    // Global functions
    "parseInt",
    "parseFloat",
    "isNaN",
    "isFinite",
    "eval",
    "decodeURI",
    "encodeURI",
    "decodeURIComponent",
    "encodeURIComponent",
    // Constructors
    "Array",
    "Object",
    "String",
    "Number",
    "Boolean",
    "Date",
    "RegExp",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "Function",
    "Symbol",
    "Promise",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "JSON",
    "Math",
    "Reflect",
    "Proxy",
    // Typed arrays
    "Uint8Array",
    "Int8Array",
    "Uint16Array",
    "Int16Array",
    "Uint32Array",
    "Int32Array",
    "Float32Array",
    "Float64Array",
    "ArrayBuffer",
    "DataView",
    "BigInt",
    "BigInt64Array",
    "BigUint64Array",
    // Hyperlight-specific globals
    "console", // Only has .log method
    "print",   // Raw output function
    // Module system
    "require",
    "import",
    // Operators (not functions but parsed as such)
    "typeof",
    "instanceof",
    // NOT AVAILABLE in hyperlight-js (do not add these):
    // - setTimeout, setInterval, clearTimeout, clearInterval
    // - fetch, Request, Response, Headers
    // - atob, btoa
    // - TextEncoder, TextDecoder
    // - URL, URLSearchParams
    // - queueMicrotask, structuredClone
    // - Intl
];

/// Check if a method name is a built-in.
pub fn is_builtin_method(name: &str) -> bool {
    BUILTIN_METHODS.contains(&name)
}

/// Check if a function name is a built-in.
pub fn is_builtin_function(name: &str) -> bool {
    BUILTIN_FUNCTIONS.contains(&name)
}

/// Extract all method calls from source code.
pub fn extract_all_method_calls(source: &str) -> Vec<MethodCallInfo> {
    let mut calls = Vec::new();

    for (line_num, line) in source.lines().enumerate() {
        // Find all `.identifier(` patterns
        let bytes = line.as_bytes();
        let mut i = 0;

        while i < bytes.len() {
            if bytes[i] == b'.' {
                // Scan backwards for object name
                let mut obj_start = i;
                while obj_start > 0
                    && (bytes[obj_start - 1].is_ascii_alphanumeric()
                        || bytes[obj_start - 1] == b'_'
                        || bytes[obj_start - 1] == b'$')
                {
                    obj_start -= 1;
                }

                // Scan forwards for method name
                let method_start = i + 1;
                let mut method_end = method_start;
                while method_end < bytes.len()
                    && (bytes[method_end].is_ascii_alphanumeric()
                        || bytes[method_end] == b'_'
                        || bytes[method_end] == b'$')
                {
                    method_end += 1;
                }

                // Skip whitespace to check for (
                let mut paren_check = method_end;
                while paren_check < bytes.len() && bytes[paren_check] == b' ' {
                    paren_check += 1;
                }

                if paren_check < bytes.len()
                    && bytes[paren_check] == b'('
                    && obj_start < i
                    && method_start < method_end
                    && let (Ok(object), Ok(method)) = (
                        core::str::from_utf8(&bytes[obj_start..i]),
                        core::str::from_utf8(&bytes[method_start..method_end]),
                    )
                {
                    // Skip built-in methods and invalid identifiers
                    if !is_builtin_method(method)
                        && !object.is_empty()
                        && (object.chars().next().is_some_and(|c| c.is_alphabetic())
                            || object.starts_with('_')
                            || object.starts_with('$'))
                    {
                        calls.push(MethodCallInfo {
                            object: String::from(object),
                            method: String::from(method),
                            line: line_num as u32 + 1,
                        });
                    }
                }
            }
            i += 1;
        }
    }

    calls
}

/// Extract all function calls from source code.
pub fn extract_all_function_calls(source: &str) -> Vec<FunctionCallInfo> {
    let mut calls = Vec::new();

    for (line_num, line) in source.lines().enumerate() {
        let bytes = line.as_bytes();
        let mut i = 0;

        // Track string state for this line
        let mut in_string = false;
        let mut string_char: u8 = 0;

        while i < bytes.len() {
            let b = bytes[i];

            // Track string boundaries (handle escape sequences)
            if !in_string && (b == b'"' || b == b'\'' || b == b'`') {
                in_string = true;
                string_char = b;
            } else if in_string && b == string_char {
                // Check for escape: count preceding backslashes
                let mut backslashes = 0;
                let mut j = i;
                while j > 0 && bytes[j - 1] == b'\\' {
                    backslashes += 1;
                    j -= 1;
                }
                // If even number of backslashes, quote is not escaped
                if backslashes % 2 == 0 {
                    in_string = false;
                }
            }

            // Skip function call detection if inside string
            if in_string {
                i += 1;
                continue;
            }

            if bytes[i] == b'(' {
                // Scan backwards for function name (skip whitespace)
                let mut func_end = i;
                while func_end > 0 && bytes[func_end - 1] == b' ' {
                    func_end -= 1;
                }

                let mut func_start = func_end;
                while func_start > 0
                    && (bytes[func_start - 1].is_ascii_alphanumeric()
                        || bytes[func_start - 1] == b'_'
                        || bytes[func_start - 1] == b'$')
                {
                    func_start -= 1;
                }

                // Check it's not a method call (preceded by .)
                let is_method = func_start > 0 && bytes[func_start - 1] == b'.';

                if !is_method
                    && func_start < func_end
                    && let Ok(func_name) = core::str::from_utf8(&bytes[func_start..func_end])
                    && !is_builtin_function(func_name)
                    && !func_name.is_empty()
                    && (func_name.chars().next().is_some_and(|c| c.is_alphabetic())
                        || func_name.starts_with('_')
                        || func_name.starts_with('$'))
                {
                    // Count arguments
                    if let Ok((_, arg_count)) = count_args(&line[i..]) {
                        calls.push(FunctionCallInfo {
                            func_name: String::from(func_name),
                            arg_count,
                            line: line_num as u32 + 1,
                        });
                    }
                }
            }
            i += 1;
        }
    }

    calls
}

/// Extract all assignments with type information from source code.
pub fn extract_all_assignments(source: &str) -> Vec<AssignmentInfo> {
    let mut assignments = Vec::new();

    for (line_num, line) in source.lines().enumerate() {
        let trimmed = line.trim();

        // Skip if not a variable declaration
        if !trimmed.starts_with("const ")
            && !trimmed.starts_with("let ")
            && !trimmed.starts_with("var ")
        {
            continue;
        }

        // Try ternary assignment first (for nullable tracking)
        if trimmed.contains('?')
            && trimmed.contains(':')
            && let Ok((_, ternary)) = ternary_assignment(trimmed)
        {
            let func = ternary.true_expr.or(ternary.false_expr);
            assignments.push(AssignmentInfo {
                var_name: String::from(ternary.var_name),
                func_name: func.map(String::from),
                method_chain: Vec::new(),
                initial_object: None,
                is_nullable: ternary.is_nullable,
                line: line_num as u32 + 1,
            });
            continue;
        }

        // Try chained method call: const x = obj.method1().method2()
        if let Ok((_, (var_name, expr))) = var_decl_chained_call(trimmed)
            && !expr.chain.is_empty()
        {
            assignments.push(AssignmentInfo {
                var_name: String::from(var_name),
                func_name: None,
                method_chain: expr.chain.iter().map(|m| String::from(m.method)).collect(),
                initial_object: Some(String::from(expr.object)),
                is_nullable: false,
                line: line_num as u32 + 1,
            });
            continue;
        }

        // Try simple function call: const x = func()
        if let Ok((_, assign)) = var_decl_assignment(trimmed) {
            assignments.push(AssignmentInfo {
                var_name: String::from(assign.var_name),
                func_name: Some(String::from(assign.func_name)),
                method_chain: Vec::new(),
                initial_object: None,
                is_nullable: false,
                line: line_num as u32 + 1,
            });
        }
    }

    assignments
}

/// Information about a property access found in source.
#[derive(Debug, Clone)]
pub struct PropertyAccessInfo {
    /// The object being accessed.
    pub object: String,
    /// The property being accessed.
    pub property: String,
    /// Line number (1-indexed).
    pub line: u32,
}

/// JavaScript built-in properties to skip during validation.
const BUILTIN_PROPERTIES: &[&str] = &[
    // Array/String properties
    "length",
    // Object properties
    "prototype",
    "constructor",
    "__proto__",
    // Common DOM/Node properties (if ever used)
    "name",
    "message",
    "stack",
];

/// Check if a property name is a built-in.
pub fn is_builtin_property(name: &str) -> bool {
    BUILTIN_PROPERTIES.contains(&name)
}

/// Extract all property accesses (non-method) from source code.
/// Returns accesses like `obj.property` but NOT `obj.method()`.
/// Skips content inside string literals and template literals to avoid false positives
/// (e.g. `"docs.rust-lang.org"` should not flag `.rust` as a property access).
pub fn extract_all_property_accesses(source: &str) -> Vec<PropertyAccessInfo> {
    let mut accesses = Vec::new();
    // Track multi-line template literal state across lines
    let mut in_template_literal = false;
    // Track `${...}` interpolation nesting depth inside template literals.
    // When > 0, we're inside an expression and should scan for property accesses.
    let mut template_brace_depth: u32 = 0;

    for (line_num, line) in source.lines().enumerate() {
        // Find all `.identifier` patterns that are NOT followed by (
        let bytes = line.as_bytes();
        let mut i = 0;
        // Track whether we're inside a string literal on this line
        let mut in_single_quote = false;
        let mut in_double_quote = false;

        while i < bytes.len() {
            let ch = bytes[i];

            // Handle escape sequences — skip the next character
            if ch == b'\\' && (in_single_quote || in_double_quote || in_template_literal) {
                i += 2; // skip escaped char
                continue;
            }

            // Track string literal boundaries
            if ch == b'\'' && !in_double_quote && !in_template_literal {
                in_single_quote = !in_single_quote;
                i += 1;
                continue;
            }
            if ch == b'"' && !in_single_quote && !in_template_literal {
                in_double_quote = !in_double_quote;
                i += 1;
                continue;
            }
            if ch == b'`' && !in_single_quote && !in_double_quote {
                // Only toggle template state when not inside an interpolation
                if template_brace_depth == 0 {
                    in_template_literal = !in_template_literal;
                }
                i += 1;
                continue;
            }

            // Handle template literal interpolation boundaries: ${ and }
            if in_template_literal
                && template_brace_depth == 0
                && ch == b'$'
                && i + 1 < bytes.len()
                && bytes[i + 1] == b'{'
            {
                // Entering ${...} — start scanning for property accesses
                template_brace_depth = 1;
                i += 2; // skip ${
                continue;
            }
            if template_brace_depth > 0 && ch == b'{' {
                template_brace_depth += 1;
                i += 1;
                continue;
            }
            if template_brace_depth > 0 && ch == b'}' {
                template_brace_depth -= 1;
                // When depth returns to 0, we're back in template literal text
                i += 1;
                continue;
            }

            // Skip template literal text (but NOT interpolation expressions)
            // Skip regular string literals entirely
            if in_single_quote
                || in_double_quote
                || (in_template_literal && template_brace_depth == 0)
            {
                i += 1;
                continue;
            }

            // Skip single-line comments
            if ch == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                break; // rest of line is comment
            }

            if ch == b'.' {
                // Scan backwards for object name
                let mut obj_start = i;
                while obj_start > 0
                    && (bytes[obj_start - 1].is_ascii_alphanumeric()
                        || bytes[obj_start - 1] == b'_'
                        || bytes[obj_start - 1] == b'$')
                {
                    obj_start -= 1;
                }

                // Scan forwards for property name
                let prop_start = i + 1;
                let mut prop_end = prop_start;
                while prop_end < bytes.len()
                    && (bytes[prop_end].is_ascii_alphanumeric()
                        || bytes[prop_end] == b'_'
                        || bytes[prop_end] == b'$')
                {
                    prop_end += 1;
                }

                // Skip whitespace to check for ( - if present, it's a method call
                let mut next_check = prop_end;
                while next_check < bytes.len() && bytes[next_check] == b' ' {
                    next_check += 1;
                }

                let is_method_call = next_check < bytes.len() && bytes[next_check] == b'(';

                // Only capture if it's NOT a method call and has valid object/property
                if !is_method_call
                    && obj_start < i
                    && prop_start < prop_end
                    && let (Ok(object), Ok(property)) = (
                        core::str::from_utf8(&bytes[obj_start..i]),
                        core::str::from_utf8(&bytes[prop_start..prop_end]),
                    )
                {
                    // Skip builtins and skip if object starts with uppercase (likely a class/static)
                    if !is_builtin_property(property)
                        && !object.is_empty()
                        && !property.is_empty()
                        && !object.chars().next().is_some_and(|c| c.is_uppercase())
                    {
                        accesses.push(PropertyAccessInfo {
                            object: String::from(object),
                            property: String::from(property),
                            line: line_num as u32 + 1,
                        });
                    }
                }

                i = prop_end;
            } else {
                i += 1;
            }
        }
    }

    accesses
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::ToString;
    use alloc::vec;

    #[test]
    fn test_identifier() {
        assert_eq!(identifier("foo"), Ok(("", "foo")));
        assert_eq!(identifier("_bar123"), Ok(("", "_bar123")));
        assert_eq!(identifier("$test"), Ok(("", "$test")));
        assert_eq!(identifier("foo.bar"), Ok((".bar", "foo")));
    }

    #[test]
    fn test_string_literal() {
        assert_eq!(string_literal("\"hello\""), Ok(("", "hello")));
        assert_eq!(string_literal("'world'"), Ok(("", "world")));
        assert_eq!(string_literal("\"ha:pptx\""), Ok(("", "ha:pptx")));
    }

    #[test]
    fn test_simple_assignment() {
        let result = simple_assignment("pres = createPresentation()").unwrap();
        assert_eq!(result.1.var_name, "pres");
        assert_eq!(result.1.func_name, "createPresentation");

        let result = simple_assignment("  x  =  func  (  ").unwrap();
        assert_eq!(result.1.var_name, "x");
        assert_eq!(result.1.func_name, "func");
    }

    #[test]
    fn test_var_decl_assignment() {
        let result = var_decl_assignment("const pres = createPresentation()").unwrap();
        assert_eq!(result.1.var_name, "pres");
        assert_eq!(result.1.func_name, "createPresentation");

        let result = var_decl_assignment("let x = foo()").unwrap();
        assert_eq!(result.1.var_name, "x");
        assert_eq!(result.1.func_name, "foo");
    }

    #[test]
    fn test_chained_method_call() {
        let result = chained_method_call("pres.addSlide()").unwrap();
        assert_eq!(result.1.object, "pres");
        assert_eq!(result.1.chain.len(), 1);
        assert_eq!(result.1.chain[0].method, "addSlide");

        let result = chained_method_call("obj.method1().method2().method3()").unwrap();
        assert_eq!(result.1.object, "obj");
        assert_eq!(result.1.chain.len(), 3);
        assert_eq!(result.1.chain[0].method, "method1");
        assert_eq!(result.1.chain[1].method, "method2");
        assert_eq!(result.1.chain[2].method, "method3");
    }

    #[test]
    fn test_var_decl_chained_call() {
        let result = var_decl_chained_call("const x = pres.build()").unwrap();
        assert_eq!(result.1.0, "x");
        assert_eq!(result.1.1.object, "pres");
        assert_eq!(result.1.1.chain[0].method, "build");
    }

    #[test]
    fn test_function_call() {
        let result = function_call("createPresentation()").unwrap();
        assert_eq!(result.1.func_name, "createPresentation");
        assert_eq!(result.1.arg_count, 0);

        let result = function_call("textBox(a, b, c)").unwrap();
        assert_eq!(result.1.func_name, "textBox");
        assert_eq!(result.1.arg_count, 3);

        let result = function_call("foo({ x: 1, y: 2 })").unwrap();
        assert_eq!(result.1.func_name, "foo");
        assert_eq!(result.1.arg_count, 1);
    }

    #[test]
    fn test_import_statement() {
        let result = import_statement("import { foo, bar } from \"ha:pptx\"").unwrap();
        assert_eq!(result.1.specifier, "ha:pptx");
        assert_eq!(result.1.names, vec!["foo", "bar"]);

        let result = import_statement("import * as pptx from 'ha:pptx'").unwrap();
        assert_eq!(result.1.specifier, "ha:pptx");

        let result = import_statement("import \"side-effect\"").unwrap();
        assert_eq!(result.1.specifier, "side-effect");
    }

    #[test]
    fn test_ternary_assignment() {
        let result = ternary_assignment("const x = cond ? createPresentation() : null").unwrap();
        assert_eq!(result.1.var_name, "x");
        assert_eq!(result.1.true_expr, Some("createPresentation"));
        assert!(result.1.is_nullable);

        let result = ternary_assignment("let y = flag ? foo() : bar()").unwrap();
        assert_eq!(result.1.var_name, "y");
        assert!(!result.1.is_nullable);
    }

    #[test]
    fn test_extract_all_imports() {
        let source = r#"
            import { foo } from "module-a";
            import * as bar from 'module-b';
            import "side-effect";
        "#;
        let imports = extract_all_imports(source);
        assert!(imports.contains(&"module-a".to_string()));
        assert!(imports.contains(&"module-b".to_string()));
        assert!(imports.contains(&"side-effect".to_string()));
    }

    #[test]
    fn test_extract_imports_ignores_prose_from_in_strings() {
        // Regression: the validator was parsing prose inside string literals as imports.
        // e.g. `"an AI that builds documents"` was extracted as a module specifier
        // because the line contained `from "an AI..."`.
        let source = r#"
            import { writeFile } from "host:fs-write";
            export function handler(event) {
                const content = "HyperAgent is an AI that builds documents from 'impressive demo' material";
                const more = "Fetched data from \"ha:pdf\" and other sources";
                writeFile("blog.md", content);
                return { ok: true };
            }
        "#;
        let imports = extract_all_imports(source);
        assert!(imports.contains(&"host:fs-write".to_string()));
        // These should NOT be extracted as imports
        assert!(!imports.iter().any(|s| s.contains("impressive demo")));
        assert!(!imports.iter().any(|s| s.contains("AI that builds")));
        // ha:pdf inside a string literal should not be picked up
        assert!(!imports.contains(&"ha:pdf".to_string()));
    }

    #[test]
    fn test_extract_imports_continuation_lines() {
        // Continuation lines like `} from "module"` should still work
        let source = r#"
            import {
                foo,
                bar
            } from "ha:pptx";
        "#;
        let imports = extract_all_imports(source);
        assert!(imports.contains(&"ha:pptx".to_string()));
    }

    #[test]
    fn test_extract_namespace_imports() {
        let source = r#"
            import { foo } from "module-a";
            import * as pptx from "ha:pptx";
            import * as fetch from "host:fetch";
            import "side-effect";
            import defaultExport from "module-b";
        "#;
        let ns_imports = extract_namespace_imports(source);
        assert_eq!(ns_imports.len(), 2);
        assert!(
            ns_imports
                .iter()
                .any(|i| i.alias == "pptx" && i.module == "ha:pptx")
        );
        assert!(
            ns_imports
                .iter()
                .any(|i| i.alias == "fetch" && i.module == "host:fetch")
        );
    }

    #[test]
    fn test_extract_all_method_calls() {
        let source = r#"
            const pres = createPresentation();
            pres.addSlide("title", shape);
            pres.build();
            console.log("done");
        "#;
        let calls = extract_all_method_calls(source);

        // Should find pres.addSlide and pres.build but not console.log
        assert!(
            calls
                .iter()
                .any(|c| c.object == "pres" && c.method == "addSlide")
        );
        assert!(
            calls
                .iter()
                .any(|c| c.object == "pres" && c.method == "build")
        );
        assert!(!calls.iter().any(|c| c.method == "log")); // console.log is builtin
    }

    #[test]
    fn test_extract_all_function_calls() {
        let source = r#"
            const pres = createPresentation();
            const box = textBox({ x: 0, y: 0, text: "hi" });
            console.log("test");
        "#;
        let calls = extract_all_function_calls(source);

        assert!(
            calls
                .iter()
                .any(|c| c.func_name == "createPresentation" && c.arg_count == 0)
        );
        assert!(
            calls
                .iter()
                .any(|c| c.func_name == "textBox" && c.arg_count == 1)
        );
        // console is builtin, should not appear
        assert!(!calls.iter().any(|c| c.func_name == "console"));
    }

    #[test]
    fn test_function_calls_ignore_strings() {
        // Regression test: "instruction set (x86)" should NOT be parsed as set(x86)
        let source = r#"
const x = "instruction set (x86)";
const y = 'another set (of items)';
const z = `template set (string)`;
realFunc(arg);
"#;
        let calls = extract_all_function_calls(source);

        // Should only find realFunc, not the "set" inside strings
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].func_name, "realFunc");
    }

    #[test]
    fn test_extract_all_assignments() {
        let source = r#"
            const pres = createPresentation();
            const x = cond ? foo() : null;
            let y = obj.method1().method2();
        "#;
        let assigns = extract_all_assignments(source);

        // Simple function call
        assert!(
            assigns
                .iter()
                .any(|a| a.var_name == "pres"
                    && a.func_name == Some("createPresentation".to_string()))
        );

        // Ternary with null
        assert!(assigns.iter().any(|a| a.var_name == "x" && a.is_nullable));

        // Chained call
        assert!(
            assigns
                .iter()
                .any(|a| a.var_name == "y" && a.final_method() == Some("method2"))
        );
    }

    #[test]
    fn test_property_access_in_template_interpolation() {
        // Property accesses inside ${...} should be detected
        // Note: "name" is in BUILTIN_PROPERTIES so use "firstName" instead
        let source = r#"const msg = `Hello ${user.firstName} from ${user.city}`;"#;
        let accesses = extract_all_property_accesses(source);
        assert!(
            accesses
                .iter()
                .any(|a| a.object == "user" && a.property == "firstName"),
            "Should detect user.firstName inside template interpolation"
        );
        assert!(
            accesses
                .iter()
                .any(|a| a.object == "user" && a.property == "city"),
            "Should detect user.city inside template interpolation"
        );
    }

    #[test]
    fn test_property_access_not_in_template_text() {
        // Dotted text in template literal text (not in ${}) should NOT be detected
        let source = r#"const url = `https://docs.rust-lang.org/book`;"#;
        let accesses = extract_all_property_accesses(source);
        assert!(
            accesses.is_empty(),
            "Should NOT detect property accesses in template literal text, got: {:?}",
            accesses
        );
    }

    #[test]
    fn test_property_access_not_in_string_literals() {
        // Dotted text in regular strings should NOT be detected
        let source = r#"const url = "https://docs.rust-lang.org/book";"#;
        let accesses = extract_all_property_accesses(source);
        assert!(
            accesses.is_empty(),
            "Should NOT detect property accesses in string literals, got: {:?}",
            accesses
        );
    }

    #[test]
    fn test_property_access_nested_braces_in_template() {
        // Nested braces inside ${...} should be handled correctly
        let source = r#"const out = `${items.filter(x => { return x.valid }).total} items`;"#;
        let accesses = extract_all_property_accesses(source);
        // items.filter() is a method call — should NOT appear as property access
        assert!(
            !accesses
                .iter()
                .any(|a| a.object == "items" && a.property == "filter"),
            "items.filter() is a method call, should not appear as property access"
        );
        // x.valid is inside nested braces — should be detected
        assert!(
            accesses
                .iter()
                .any(|a| a.object == "x" && a.property == "valid"),
            "Should detect x.valid inside nested braces in template interpolation"
        );
    }

    #[test]
    fn test_property_access_mixed_template_and_code() {
        // Mix of template text and real code on same line
        let source = r#"console.log(`Result: ${data.value}`); const x = obj.prop;"#;
        let accesses = extract_all_property_accesses(source);
        assert!(
            accesses
                .iter()
                .any(|a| a.object == "data" && a.property == "value"),
            "Should detect data.value in template interpolation"
        );
        assert!(
            accesses
                .iter()
                .any(|a| a.object == "obj" && a.property == "prop"),
            "Should detect obj.prop outside template"
        );
    }
}
