// propose.mjs가 LLM이 다시 쓴 hintPrompt.ts를 PR로 올리기 전에 거르는 검사들.
// 테스트(promptGuard.test.mjs)에서도 쓰려고 따로 뺐다(2026-09-28).

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const SIGNATURE = 'export function hintSystem(round: 1 | 2, category: string, hintCount: number): string {';

// 구조 가드 — 모델이 형식은 지켰지만 내용을 이상하게 바꿨을 가능성을 걸러낸다.
export function structuralGuardOk(fileContent) {
  const checks = [
    fileContent.includes(SIGNATURE),
    fileContent.includes('"banned"'),
    // avoidFillers는 백엔드가 파싱하진 않지만 효과가 실측으로 확인된 장치라 지우면 안 된다.
    fileContent.includes('"avoidFillers"'),
    fileContent.includes('"hints"'),
    fileContent.includes('"text"'),
    fileContent.includes('"angle"'),
    !fileContent.includes('\nimport '),
    fileContent.length > 300,
    fileContent.length < 8000,
  ];
  return checks.every(Boolean);
}

// 코드 가드(2026-09-28) — 파일이 "hintSystem 함수 하나 + 템플릿 문자열 하나를 돌려주는
// return 하나"뿐이고, 템플릿 안 ${...} 자리엔 round·category·hintCount와 비교·삼항·
// 문자열만 쓰였는지 구문 트리로 확인한다. import만 막던 예전 가드로는 ${require(...)} 같은
// 코드를 템플릿 안에 넣어도 tsc를 통과했다 — 이 파일은 서버에서 실행되고, 입력인 피드백은
// 누구나 남길 수 있다. 통과하면 null, 아니면 이유 문자열.
const ALLOWED_IDENTIFIERS = new Set(['round', 'category', 'hintCount']);

function expressionProblem(node) {
  const k = ts.SyntaxKind;
  switch (node.kind) {
    case k.Identifier:
      return ALLOWED_IDENTIFIERS.has(node.text) ? null : `허용되지 않은 이름 "${node.text}"`;
    case k.StringLiteral:
    case k.NumericLiteral:
    case k.NoSubstitutionTemplateLiteral:
      return null;
    case k.TemplateExpression:
      for (const span of node.templateSpans) {
        const p = expressionProblem(span.expression);
        if (p) return p;
      }
      return null;
    case k.ParenthesizedExpression:
      return expressionProblem(node.expression);
    case k.ConditionalExpression:
      return expressionProblem(node.condition) ?? expressionProblem(node.whenTrue) ?? expressionProblem(node.whenFalse);
    case k.BinaryExpression: {
      const ops = [
        k.EqualsEqualsEqualsToken,
        k.ExclamationEqualsEqualsToken,
        k.LessThanToken,
        k.GreaterThanToken,
        k.LessThanEqualsToken,
        k.GreaterThanEqualsToken,
        k.AmpersandAmpersandToken,
        k.BarBarToken,
        k.PlusToken,
        k.MinusToken,
      ];
      if (!ops.includes(node.operatorToken.kind)) return `허용되지 않은 연산자 "${node.operatorToken.getText()}"`;
      return expressionProblem(node.left) ?? expressionProblem(node.right);
    }
    default:
      return `허용되지 않은 표현식 "${node.getText().slice(0, 60)}"`;
  }
}

export function codeGuardProblem(fileContent) {
  const sf = ts.createSourceFile('hintPrompt.ts', fileContent, ts.ScriptTarget.Latest, true);
  if (sf.statements.length !== 1) return `최상위 문장이 ${sf.statements.length}개(함수 하나만 있어야 함)`;
  const fn = sf.statements[0];
  if (!ts.isFunctionDeclaration(fn) || fn.name?.text !== 'hintSystem' || !fn.body) return 'hintSystem 함수 선언이 아님';
  if (fn.body.statements.length !== 1) return '함수 본문에 return 말고 다른 문장이 있음';
  const ret = fn.body.statements[0];
  if (!ts.isReturnStatement(ret) || !ret.expression) return '함수 본문이 return 하나가 아님';
  // 모양: `...`.trim()
  const call = ret.expression;
  if (
    !ts.isCallExpression(call) ||
    call.arguments.length !== 0 ||
    !ts.isPropertyAccessExpression(call.expression) ||
    call.expression.name.text !== 'trim'
  ) {
    return 'return 값이 `...`.trim() 모양이 아님';
  }
  return expressionProblem(call.expression.expression);
}
