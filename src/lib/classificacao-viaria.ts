// Taxonomia simplificada de vias OSM (highway=*) em 3 classes -- ver
// docs/superpowers/specs/2026-07-21-classe-viaria-desvio-design.md.
// Funcoes PURAS, sem I/O -- reaproveitadas tanto pelo script de ingestao
// (scripts/ingerir-vias-celulas.mjs, que duplica esta logica em JS puro
// por convencao do projeto -- scripts .mjs nao importam de src/lib/*.ts)
// quanto pelo motor (src/app/api/motor/route.ts).
export type ClasseViaria = "principal" | "intermediaria" | "estreita";

const TAXONOMIA_VIARIA: Record<string, ClasseViaria> = {
  motorway: "principal", motorway_link: "principal",
  trunk: "principal", trunk_link: "principal",
  primary: "principal", primary_link: "principal",
  secondary: "principal", secondary_link: "principal",
  tertiary: "intermediaria", tertiary_link: "intermediaria",
  unclassified: "intermediaria", living_street: "intermediaria",
  residential: "estreita", service: "estreita", track: "estreita",
};

export function classificarVia(tagHighway: string): ClasseViaria | null {
  return TAXONOMIA_VIARIA[tagHighway] ?? null;
}

const PRIORIDADE_CLASSE: Record<ClasseViaria, number> = {
  principal: 3, intermediaria: 2, estreita: 1,
};

// Célula pode ser cruzada por vias de classes diferentes -- vence a de
// maior prioridade (uma célula "tem acesso" à melhor via que passa nela).
export function melhorClasse(
  a: ClasseViaria | null, b: ClasseViaria | null
): ClasseViaria | null {
  if (a === null) return b;
  if (b === null) return a;
  return PRIORIDADE_CLASSE[a] >= PRIORIDADE_CLASSE[b] ? a : b;
}
