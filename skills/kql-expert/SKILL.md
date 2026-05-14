---
name: kql-expert
description: KQL language expertise for writing correct, efficient Kusto queries using Fabric RTI MCP tools
triggers:
  - KQL
  - Kusto
  - ADX
  - Azure Data Explorer
  - Fabric Eventhouse
  - Eventhouse
  - log analysis
  - time series
  - anomaly detection
  - kusto_query
  - kusto_command
  - Kusto query
  - KQL query
  - kusto.windows.net
  - summarize by
  - make-series
  - dcount
  - render timechart
  - render piechart
  - .show tables
  - .show database
  - Kusto cluster
  - Kusto table
  - ADX cluster
  - Log Analytics
  - Application Insights
  - real-time intelligence
  - telemetry
  - mv-expand
  - externaldata
  - materialized view
  - ingestion
  - analyze logs
  - query logs
  - error spikes
  - failed requests
patterns:
  - fetch-and-process
antiPatterns:
  - Don't guess KQL syntax — use the self-correction table and query checklist
  - Don't switch query approaches on first error — fix the specific error first
  - Don't scan large tables without pre-filtering with | where
  - Don't use dynamic columns in by/on/order by without explicit casts
  - Don't use extract_all without capturing groups in the regex
  - Don't call kusto_query for management commands — use kusto_command for .show/.create/.alter
  - Don't hardcode MCP tool schemas — call mcp_tool_info first
  - Don't call MCP tools directly — execute them inside registered handler code
  - Don't use azuremcpserver for KQL — always use fabric-rti-mcp which has dedicated Kusto tools
requires-mcp:
  - fabric-rti-mcp
allowed-tools:
  - register_handler
  - execute_javascript
  - execute_bash
  - delete_handler
  - get_handler_source
  - edit_handler
  - list_handlers
  - reset_sandbox
  - list_modules
  - module_info
  - list_plugins
  - plugin_info
  - manage_plugin
  - list_mcp_servers
  - mcp_server_info
  - mcp_tool_info
  - manage_mcp
  - apply_profile
  - configure_sandbox
  - sandbox_help
  - register_module
  - write_output
  - read_input
  - read_output
  - ask_user
---

# KQL Expert — Kusto Query Language Mastery

> **Try it yourself**: All `✅` examples use the public help cluster:
> `https://help.kusto.windows.net`, database `Samples` (StormEvents, nyc_taxi, etc.).

## 1. Running KQL with Fabric RTI MCP

The `fabric-rti-mcp` MCP server exposes Kusto as MCP tools. Authentication
is handled transparently via Azure Identity.

### Handler Execution Pattern

MCP tools run inside registered handlers — never call them directly:

```javascript
// 1. Connect the MCP server
manage_mcp({ action: "connect", name: "fabric-rti-mcp" });

// 2. Get tool schemas
mcp_tool_info({ name: "fabric-rti-mcp", query: "query" });

// 3. Apply mcp-network profile for wall-clock time
apply_profile({ profiles: "mcp-network" });

// 4. Register handler that imports MCP tools
register_handler({
  name: "run-kql",
  code: `
    import { kusto_query } from "host:mcp-fabric-rti-mcp";
    export default async function(input) {
      const result = await kusto_query({
        query: "StormEvents | summarize count() by State | top 5 by count_ desc",
        cluster_uri: "https://help.kusto.windows.net",
        database: "Samples"
      });
      if (!result.ok) return { error: result.error };
      return result.data;
    }
  `,
});

// 5. Execute
execute_javascript({ handler: "run-kql" });
```

### Available MCP Tools

| Tool                             | Purpose                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `kusto_query`                    | Execute a KQL query on a database                          |
| `kusto_command`                  | Execute a management command (`.show`, `.create`, etc.)    |
| `kusto_list_entities`            | List databases, tables, external tables, functions, graphs |
| `kusto_describe_database`        | Get schema for all entities in a database                  |
| `kusto_describe_database_entity` | Get schema for a specific entity                           |
| `kusto_sample_entity`            | Get sample data from a table or entity                     |
| `kusto_graph_query`              | Execute a graph query (snapshots or transient)             |
| `kusto_ingest_inline_into_table` | Ingest inline CSV data into a table                        |
| `kusto_known_services`           | List configured Kusto services                             |
| `kusto_get_shots`                | Retrieve semantically similar query examples               |
| `kusto_deeplink_from_query`      | Build a deeplink URL for the web explorer                  |
| `kusto_show_queryplan`           | Get the execution plan without running it                  |
| `kusto_diagnostics`              | Get cluster health and capacity summary                    |

### Query vs Management Commands

KQL has two execution planes, each with its own MCP tool:

| Plane          | Tool            | Starts with                                   | Examples                                |
| -------------- | --------------- | --------------------------------------------- | --------------------------------------- |
| **Query**      | `kusto_query`   | Table name, `let`, `print`, `datatable`       | `StormEvents \| where State == "TEXAS"` |
| **Management** | `kusto_command` | `.show`, `.create`, `.set`, `.drop`, `.alter` | `.show tables`, `.show table T schema`  |

### Exploration Workflow

When encountering a new cluster or database:

1. **List entities**: `kusto_list_entities(cluster_uri, entity_type="tables", database="MyDB")`
2. **Get schema**: `kusto_describe_database_entity(entity_name="MyTable", entity_type="table", ...)`
3. **Sample data**: `kusto_sample_entity(entity_name="MyTable", entity_type="table", sample_size=5, ...)`
4. **Count rows**: `kusto_query(query="MyTable | count", ...)`
5. **Run analysis**: `kusto_query(query="MyTable | where ... | summarize ...", ...)`

## 2. Dynamic Type Discipline

KQL's `dynamic` type is flexible but strict in certain contexts. A common mistake
is using a dynamic column in `summarize by`, `order by`, or `join on` without
casting.

**The rule**: Any time you use a dynamic-typed column in `by`, `on`, or
`order by`, wrap it in an explicit cast.

```kql
// ❌ ERROR: "Summarize group key 'Partners' is of a 'dynamic' type"
| summarize count() by Partners

// ✅ FIX
| summarize count() by tostring(Partners)
```

```kql
// ❌ ERROR in join: dynamic join key
| join kind=inner other on $left.Area == $right.Area

// ✅ FIX — cast both sides
| extend Area_str = tostring(Area)
| join kind=inner (other | extend Area_str = tostring(Area)) on Area_str
```

**Self-correction**: When you see "is of a 'dynamic' type" in an error, add
`tostring()`, `tolong()`, or `todouble()`.

## 3. Join Patterns & Pitfalls

KQL joins have constraints that differ from SQL.

### Equality Only

KQL join conditions support **only `==`**. No `<`, `>`, `!=`, or function calls.

```kql
// ❌ ERROR: "Only equality is allowed in this context"
| join on geo_distance_2points(a.Lat, a.Lon, b.Lat, b.Lon) < 1000

// ✅ WORKAROUND — pre-bucket into spatial cells, then join on cell ID
| extend cell = geo_point_to_s2cell(Lon, Lat, 8)
| join kind=inner (other | extend cell = geo_point_to_s2cell(Lon, Lat, 8)) on cell
```

### Left/Right Attribute Matching

Both sides of a join `on` clause must reference column entities only.

```kql
// ❌ ERROR: "for each left attribute, right attribute should be selected"
| join kind=inner other on $left.col1

// ✅ FIX — specify both sides explicitly
| join kind=inner other on $left.col1 == $right.col1
```

### Cardinality Check Before Large Joins

**Always** check cardinality before joining tables with >10K rows.

```kql
// Before joining, check how many rows each side contributes
TableA | summarize dcount(JoinKey)  // → 25,000? Too many unconstrained
TableB | summarize dcount(JoinKey)  // → 195? OK if filtered first
```

## 4. Regex in KQL

### The extract_all Gotcha

KQL's `extract_all` **requires capturing groups** in the regex:

```kql
// ❌ ERROR: "extractall(): argument 2 must be a valid regex with [1..16] matching groups"
| extend words = extract_all(@"[a-zA-Z]{3,}", Text)

// ✅ FIX — add parentheses around the pattern
| extend words = extract_all(@"([a-zA-Z]{3,})", Text)
```

### Regex Toolkit

| Function                        | Use case                 | Example                                       |
| ------------------------------- | ------------------------ | --------------------------------------------- |
| `extract(regex, group, source)` | Single match             | `extract(@"User '([^']+)'", 1, Msg)`          |
| `extract_all(regex, source)`    | All matches (needs `()`) | `extract_all(@"(\w+)", Text)`                 |
| `parse`                         | Structured extraction    | `parse Msg with * "User '" Sender "' sent" *` |
| `matches regex`                 | Boolean filter           | `where Url matches regex @"^https?://"`       |
| `replace_regex`                 | Find and replace         | `replace_regex(Text, @"\s+", " ")`            |

## 5. Serialization Requirements

Window functions need serialized (ordered) input.

```kql
// ❌ ERROR: "Function 'row_cumsum' cannot be invoked. The row set must be serialized."
| summarize Online = sum(Direction) by bin(Timestamp, 5m)
| extend CumulativeOnline = row_cumsum(Online)

// ✅ FIX — add | serialize (or | order by, which implicitly serializes)
| summarize Online = sum(Direction) by bin(Timestamp, 5m)
| order by Timestamp asc
| extend CumulativeOnline = row_cumsum(Online)
```

Functions requiring serialization: `row_number()`, `row_cumsum()`, `prev()`,
`next()`, `row_window_session()`.

## 6. Memory-Safe Query Patterns

### The Progression of Safety

```
Safest ──────────────────────────────────────────── Most dangerous
| count    | take 10    | where + summarize    | summarize (no filter)    | full scan
```

### Rules for Large Tables (>1M rows)

1. **Always start with `| count`** to understand table size
2. **Always `| where` before `| summarize`** — filter time range or category first
3. **Never `dcount()` on high-cardinality columns** without pre-filtering
4. **Check join cardinality** before executing (see Section 3)
5. **Use `materialize()`** for subqueries referenced multiple times

### When You See `E_LOW_MEMORY_CONDITION`

The query touched too much data. Options:

- Add `| where` filters (time range, partition key)
- Reduce the number of `by` columns in `summarize`
- Break into smaller time windows and union results
- Use `| sample 10000` for exploratory work

### When You See `E_RUNAWAY_QUERY`

A join or aggregation produced too many output rows. Check join cardinality.

## 7. Result Size Discipline

| Query type                   | Safeguard                                        |
| ---------------------------- | ------------------------------------------------ |
| Exploratory                  | Always end with `\| take 10` or `\| take 20`     |
| Aggregation                  | Use `\| top 20 by ...` not unbounded `summarize` |
| Wide rows (vectors, JSON)    | `\| project` only needed columns                 |
| `make_list()` / `make_set()` | Avoid on high-cardinality groups                 |
| Unknown size                 | Run `\| count` first                             |

**The vector trap**: Tables with embedding columns (1536-dim float arrays)
produce ~30KB per row. Always `| project` away vector columns unless needed.

## 8. String Comparison Strictness

```kql
// ❌ ERROR: "Cannot compare values of types string and string"
| where geo_point_to_s2cell(Lon, Lat, 16) == other_cell

// ✅ FIX — wrap both sides in tostring()
| where tostring(geo_point_to_s2cell(Lon, Lat, 16)) == tostring(other_cell)
```

## 9. Advanced Functions

### Vector Similarity

```kql
let target = pack_array(5.1, 3.5, 1.4, 0.2);
Iris
| extend Vec = pack_array(SepalLength, SepalWidth, PetalLength, PetalWidth)
| extend sim = series_cosine_similarity(Vec, target)
| top 5 by sim desc
```

### Geo Operations

```kql
// Distance between two points (meters)
StormEvents | extend dist = geo_distance_2points(BeginLon, BeginLat, EndLon, EndLat)

// Spatial bucketing for joins
StormEvents | extend cell = geo_point_to_s2cell(BeginLon, BeginLat, 8)
```

### Graph Queries

Use the `kusto_graph_query` MCP tool for graph traversal:

```kql
// Persistent graph model
graph("Simple")
| graph-match (src)-[e*1..5]->(dst)
  where src.name == "Alice"
  project src.name, dst.name, path_length = array_length(e)
```

### Time Series

```kql
StormEvents
| make-series count() default=0 on StartTime step 1d
| extend anomalies = series_decompose_anomalies(count_)
```

## 10. Self-Correction Lookup Table

When you encounter an error, look it up here before retrying:

| Error message contains                             | Likely cause                           | Fix                                             |
| -------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `is of a 'dynamic' type`                           | Dynamic column in `by`/`on`/`order by` | Wrap in `tostring()`/`tolong()`                 |
| `Only equality is allowed`                         | Range predicate in join                | Pre-bucket with S2 cells or `bin()`             |
| `extractall(): matching groups`                    | Missing `()` in regex                  | Add `()`: `@"(\w+)"` not `@"\w+"`               |
| `row set must be serialized`                       | Window function on unsorted data       | Add `\| serialize` or `\| order by`             |
| `Cannot compare values of types string and string` | Computed string comparison             | Add `tostring()` on both sides                  |
| `Failed to resolve column named 'X'`               | Wrong column name                      | Use `kusto_describe_database_entity` to check   |
| `E_LOW_MEMORY_CONDITION`                           | Query touched too much data            | Add `\| where` filters, reduce time range       |
| `E_RUNAWAY_QUERY`                                  | Join produced too many rows            | Check cardinality; add pre-filters              |
| `for each left attribute, right attribute`         | Join `on` incomplete                   | Use `on $left.X == $right.Y`                    |
| `needs to be bracketed`                            | Reserved word as identifier            | Use `['keyword']` syntax                        |
| `Expected string literal in datetime()`            | Bare integer in datetime               | Use `datetime(2024-01-01)` not `datetime(2024)` |
| `Unexpected token` after `by`                      | Complex expression in summarize        | `extend` first, then `summarize by` column      |

## 11. Datetime Pitfalls

### Literal Format

```kql
// ❌ WRONG — bare year is not a valid datetime
| where StartTime > datetime(2007)

// ✅ RIGHT — always use full date format
| where StartTime > datetime(2007-01-01)
```

### Filtering by Year/Month/Hour

```kql
// ❌ WRONG — comparing datetime to integer
| where StartTime == 2007

// ✅ RIGHT — use datetime_part()
| where datetime_part("year", StartTime) == 2007

// ✅ ALSO RIGHT — use between
| where StartTime between (datetime(2007-01-01) .. datetime(2007-12-31T23:59:59))
```

### Useful Datetime Functions

| Function                    | Purpose              | Example                                                                           |
| --------------------------- | -------------------- | --------------------------------------------------------------------------------- |
| `bin(ts, 1h)`               | Round down to bucket | `bin(Timestamp, 1d)`                                                              |
| `startofmonth(ts)`          | First day of month   | `startofmonth(Timestamp)`                                                         |
| `datetime_part("hour", ts)` | Extract component    | `datetime_part("year", Timestamp)`                                                |
| `format_datetime(ts, fmt)`  | Format as string     | `format_datetime(Timestamp, "yyyy-MM")`                                           |
| `ago(1d)`                   | Relative time        | `where Timestamp > ago(1d)`                                                       |
| `between(a .. b)`           | Range filter         | `where Timestamp between (datetime(2024-01-01) .. datetime(2024-01-31T23:59:59))` |

## 12. Operator Naming & Equality

### Equality Operators

```kql
| where State == "TEXAS"      // case-sensitive exact match
| where State =~ "texas"      // case-insensitive
| where State != "TEXAS"      // not equal
| where State !~ "texas"      // case-insensitive not equal
```

### contains vs has

```kql
// contains: substring match (slower)
| where Message contains "error"    // finds "MyErrorHandler" too

// has: term/word match (faster, uses index)
| where Message has "error"         // word boundaries only
```

## 13. Error Recovery Strategy

When a first KQL query fails, the correct response is almost always to
**fix the specific error**, not change strategy.

### The Correct Pattern

```
Query 1: extract(@"pattern", 1, col)  → Parse error (bad escaping)
Query 2: extract(@"pattern", 1, col)  → Fix the specific issue → Success
```

**Rules**:

1. Read the error message — it tells you exactly what's wrong
2. Fix the **specific** syntax/escaping issue, don't switch approaches
3. Use the self-correction table (Section 10) to map errors to fixes
4. Only switch approaches after 2 failed fixes of the same query

## 14. Query Writing Checklist

Before running any KQL query, mentally check:

1. **Pre-filtered?** Large tables have `| where` before `| summarize`
2. **Result bounded?** Exploratory queries end with `| take N` or `| top N`
3. **Dynamic columns cast?** Dynamic columns in `by`/`on`/`order by` are wrapped
4. **Regex has groups?** `extract_all` patterns have `()` around captures
5. **Join cardinality safe?** Both sides checked with `dcount()` before joining
6. **Needed columns only?** Wide tables get `| project` to drop unneeded columns
7. **Datetime literals valid?** Using `datetime(2024-01-01)` not `datetime(2024)`
8. **Complex by-expressions?** Use `| extend` first, then `| summarize by` column
9. **Error recovery plan?** Fix the specific error — don't change strategy
10. **Right tool?** `kusto_query` for queries, `kusto_command` for management
11. **Checked the plan?** For expensive queries, use `kusto_show_queryplan` first

## 15. Diagnostics & Query Optimization

### Query Plan Analysis

Use `kusto_show_queryplan` to plan a query without executing it:

| Field                                         | What it tells you                                 |
| --------------------------------------------- | ------------------------------------------------- |
| `stats.PlanSize`                              | Overall plan complexity — compare two approaches  |
| `execution_hints.estimated_rows`              | Total rows expected — **strongest cost signal**   |
| `execution_hints.shard_scans[].has_selection` | `true` = filter narrows scan; `false` = full scan |

### Comparing Two Approaches

Plan both, compare `estimated_rows` and `shard_scans`. Flag a rewrite as a
regression if `estimated_rows` increases >50%.

### Cluster Diagnostics

Use `kusto_diagnostics` before heavy workloads to check capacity:

| Section              | What it tells you                                              |
| -------------------- | -------------------------------------------------------------- |
| `capacity`           | Resource slots: Queries, Ingestions (Total/Consumed/Remaining) |
| `cluster`            | Node count, cores, RAM                                         |
| `principal_roles`    | Your permissions per database                                  |
| `ingestion_failures` | Failed ingestions in last 24h                                  |
