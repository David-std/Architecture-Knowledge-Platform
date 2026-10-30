alter table knowledge_units
  drop constraint if exists knowledge_units_unit_type_check;

alter table knowledge_units
  add constraint knowledge_units_unit_type_check check (
    unit_type in (
      'DOCUMENT','SECTION','PARAGRAPH','LIST','TABLE','TABLE_ROW','TABLE_CELL',
      'FIGURE','EQUATION','PRECONDITION','RULE','WORKFLOW_STEP','EXAMPLE',
      'COUNTEREXAMPLE','EVIDENCE','SOURCE_EXCERPT','CODE_EVIDENCE'
    )
  );
