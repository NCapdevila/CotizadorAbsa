import { describe, expect, it } from "vitest";
import {
  armarTemplateComercial,
  parseCondicionesAseguradoras,
  type AbsaComercialTemplate,
} from "../src/quote/absaTemplate.js";
import { elegirComision, elegirConfiguracion } from "../src/quote/absaComercialClient.js";
import { consultasDeProductor, rankearProductores } from "../src/quote/productorMatch.js";
import { parseComboProductores } from "../src/quote/productoresCatalogo.js";
import { buscarProductorMapeado, resolverProductor } from "../src/quote/productoresConfig.js";
import { BusinessValidationError, UpstreamChangedError } from "../src/quote/errors.js";
import type { ProductorMapeado } from "../src/quote/productoresConfig.js";

/**
 * Recorte del HTML real de `/AutoCotizador/ObtenerConfigCotizador` (el campo
 * `View` de su JSON). No es el HTML completo de un productor real -- eso es
 * config comercial del broker y no va al repo -- pero si reproduce las cuatro
 * rarezas que tiene el de verdad, que son las que puede romper el parser:
 *
 *  1. El name real viaja en `Name=` (mayuscula) y ademas hay un `name=`
 *     (minuscula) con un id corto. HTML no distingue mayusculas en los
 *     atributos: gana el primero, que es el que sirve.
 *  2. Selects sin ninguna opcion `selected` (submitean la primera).
 *  3. Checkbox + hidden de ASP.NET MVC con el mismo name.
 *  4. Dos selects distintos con el MISMO name (Comercial.PlanAsegFedPat).
 */
const VIEW_HTML = `
<div id="condicionesAseguradoras">
<input Name="Comercial.ConfigCotizacion.Aseguradoras[0].id_Aseguradora" id="id_Aseguradora0" name="id_Aseguradora" type="hidden" value="2" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[0].Aseguradora" id="Aseguradora0" name="Aseguradora" type="hidden" value="ZURICH" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[1].id_Aseguradora" id="id_Aseguradora1" name="id_Aseguradora" type="hidden" value="21" />
<input Name="Comercial.ConfigCotizacion.Aseguradoras[1].Aseguradora" id="Aseguradora1" name="Aseguradora" type="hidden" value="SANCOR" />
<select name="Comercial.RebajaZurich" id="RebajaZurich">
  <option value="0" selected="selected">0</option>
  <option value="10">10</option>
  <option value="25">25</option>
</select>
<select name="Comercial.ClausulaAjusteZurich" id="ClausulaAjusteZurich">
  <option value="20">20</option>
  <option value="30">30</option>
</select>
<select name="Comercial.PlanAsegFedPat" id="PlanAsegFedPat1">
  <option value="350001" selected="selected">AP FAMILIARES TRANSPORTADOS</option>
</select>
<select name="Comercial.PlanAsegFedPat" id="PlanAsegFedPat2">
  <option value="360012" selected="selected">A3 SALUD PROTEGIDA A</option>
</select>
<input class="form-check-input" id="Taller" name="Comercial.TallerFedPat" type="checkbox" value="true" />
<input name="Comercial.TallerFedPat" type="hidden" value="false" />
<input class="form-check-input" checked="checked" id="Interasegurado" name="Comercial.InteraseguradoFedPat" type="checkbox" value="true" />
<input name="Comercial.InteraseguradoFedPat" type="hidden" value="false" />
<input name="Comercial.FechaNacimientoConductorSura" type="text" value="" />
</div>
`;

const BASE: AbsaComercialTemplate = {
  idOrganizador: 48,
  idUsuario: 2355,
  idProductor: 1,
  idConfiguracion: 1,
  comision: 20,
  idTipoPago: 3,
  aseguradoras: [{ id: 2, nombre: "ZURICH" }],
  camposPorAseguradora: { "Comercial.RebajaZurich": 30 },
};

function entrada(over: Partial<ProductorMapeado> = {}): ProductorMapeado {
  return { clave: "xango", idProductor: 9767, alias: [], ...over };
}

describe("parseCondicionesAseguradoras", () => {
  const condiciones = parseCondicionesAseguradoras(VIEW_HTML);

  it("saca las aseguradoras habilitadas del productor, en orden", () => {
    expect(condiciones.aseguradoras).toEqual([
      { id: 2, nombre: "ZURICH" },
      { id: 21, nombre: "SANCOR" },
    ]);
  });

  it("no deja los campos Aseguradoras[i] entre los campos comerciales (los arma el mapper)", () => {
    const sobrantes = Object.keys(condiciones.campos).filter((c) => c.includes("Aseguradoras["));
    expect(sobrantes).toEqual([]);
  });

  it("de un select toma la opcion 'selected'", () => {
    expect(condiciones.campos["Comercial.RebajaZurich"]).toBe("0");
  });

  it("de un select sin 'selected' toma la primera, que es lo que submitea el navegador", () => {
    expect(condiciones.campos["Comercial.ClausulaAjusteZurich"]).toBe("20");
  });

  it("guarda las opciones validas de cada select (es lo que valida los overrides)", () => {
    expect(condiciones.opciones["Comercial.RebajaZurich"]?.map((o) => o.value)).toEqual(["0", "10", "25"]);
  });

  it("un checkbox sin marcar vale false y el hidden de MVC no lo pisa", () => {
    expect(condiciones.campos["Comercial.TallerFedPat"]).toBe("false");
  });

  it("un checkbox marcado vale true", () => {
    expect(condiciones.campos["Comercial.InteraseguradoFedPat"]).toBe("true");
  });

  it("con dos campos del mismo nombre gana el primero (asi viene mandandose desde siempre)", () => {
    expect(condiciones.campos["Comercial.PlanAsegFedPat"]).toBe("350001");
  });

  it("falla explicito si no hay ninguna aseguradora (productor sin habilitar, o ABSA cambio el HTML)", () => {
    expect(() => parseCondicionesAseguradoras("<div>sin nada</div>")).toThrow(UpstreamChangedError);
  });
});

describe("armarTemplateComercial", () => {
  const condiciones = parseCondicionesAseguradoras(VIEW_HTML);

  it("toma de la cuenta lo que es de la cuenta y del productor lo que es del productor", () => {
    const template = armarTemplateComercial({
      base: BASE,
      idProductor: 9767,
      idConfiguracion: 4444,
      comision: 15,
      condiciones,
    });

    expect(template.idOrganizador).toBe(BASE.idOrganizador);
    expect(template.idUsuario).toBe(BASE.idUsuario);
    expect(template.idTipoPago).toBe(BASE.idTipoPago);
    expect(template.idProductor).toBe(9767);
    expect(template.idConfiguracion).toBe(4444);
    expect(template.comision).toBe(15);
    expect(template.aseguradoras.map((a) => a.id)).toEqual([2, 21]);
  });

  it("NO hereda las rebajas de la plantilla de archivo: son del acuerdo de OTRO productor", () => {
    const template = armarTemplateComercial({
      base: BASE,
      idProductor: 9767,
      idConfiguracion: 4444,
      comision: 15,
      condiciones,
    });
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe("0");
  });

  it("aplica los overrides del mapeo encima de los defaults de ABSA", () => {
    const template = armarTemplateComercial({
      base: BASE,
      idProductor: 9767,
      idConfiguracion: 4444,
      comision: 15,
      condiciones,
      overrides: { "Comercial.RebajaZurich": 25 },
    });
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(25);
  });

  it("un override que ABSA no ofrece se manda igual (ABSA es la autoridad final), pero queda avisado", () => {
    const template = armarTemplateComercial({
      base: BASE,
      idProductor: 9767,
      idConfiguracion: 4444,
      comision: 15,
      condiciones,
      overrides: { "Comercial.RebajaZurich": 99 },
    });
    expect(template.camposPorAseguradora["Comercial.RebajaZurich"]).toBe(99);
  });
});

describe("elegirConfiguracion", () => {
  const UNA = [{ value: "3345", text: "STD ARDAMA" }];
  const VARIAS = [
    { value: "3345", text: "STD ARDAMA" },
    { value: "9001", text: "PREFERENCIAL" },
  ];

  it("con una sola configuracion la elige sola, igual que el portal", () => {
    expect(elegirConfiguracion(entrada(), UNA)).toBe(3345);
  });

  it("respeta la del mapeo si existe para ese productor", () => {
    expect(elegirConfiguracion(entrada({ idConfiguracion: 9001 }), VARIAS)).toBe(9001);
  });

  it("falla si la del mapeo no es de ese productor (seria cotizar con la tarifa de otro)", () => {
    expect(() => elegirConfiguracion(entrada({ idConfiguracion: 7777 }), VARIAS)).toThrow(BusinessValidationError);
    expect(() => elegirConfiguracion(entrada({ idConfiguracion: 7777 }), VARIAS)).toThrow(/disponibles/i);
  });

  it("permite elegirla por nombre", () => {
    expect(elegirConfiguracion(entrada({ configuracion: "std ardama" }), VARIAS)).toBe(3345);
  });

  it("con varias y sin elegir, falla en vez de tomar una al azar", () => {
    expect(() => elegirConfiguracion(entrada(), VARIAS)).toThrow(/no dice cual usar/i);
  });

  it("sin ninguna configuracion, falla diciendo que ese productor no puede cotizar", () => {
    expect(() => elegirConfiguracion(entrada(), [])).toThrow(/no devolvio ninguna configuracion/i);
  });
});

describe("elegirComision", () => {
  const cfg = { comisiones: [10, 15, 20, 25], comisionPrincipal: 25 };

  it("sin comision en el mapeo usa la que ABSA propone para ese productor", () => {
    expect(elegirComision(entrada(), cfg)).toBe(25);
  });

  it("respeta la del mapeo", () => {
    expect(elegirComision(entrada({ comision: 15 }), cfg)).toBe(15);
  });

  it("manda igual una comision que ABSA no lista (queda el warning en el log)", () => {
    expect(elegirComision(entrada({ comision: 33 }), cfg)).toBe(33);
  });
});

describe("rankearProductores", () => {
  const CATALOGO = [
    { value: "6856", text: "ARDAMA 2020 S.A." },
    { value: "9767", text: "XANGO AUTOS, CONCESIONARIA" },
    { value: "7616", text: "WOSCOFF, GABRIEL" },
    { value: "9590", text: "1989 MOTORS, CONCESIONARIA" },
  ];

  it("encuentra al productor aunque falten la razon social y la forma societaria", () => {
    const [mejor] = rankearProductores(CATALOGO, "ardama");
    expect(mejor?.value).toBe("6856");
    expect(mejor?.similitud).toBe(100);
  });

  it("ignora el orden apellido/nombre", () => {
    const [mejor] = rankearProductores(CATALOGO, "Gabriel Woscoff");
    expect(mejor?.value).toBe("7616");
  });

  it("'CONCESIONARIA' no infla el parecido: si fuera asi todas se parecerian entre si", () => {
    const ranking = rankearProductores(CATALOGO, "concesionaria");
    expect(ranking.every((c) => c.similitud === 0)).toBe(true);
  });

  it("el que no tiene nada que ver queda abajo y dice que le falto", () => {
    const ranking = rankearProductores(CATALOGO, "xango autos");
    expect(ranking[0]?.value).toBe("9767");
    expect(ranking.at(-1)?.faltantes.length).toBeGreaterThan(0);
  });
});

describe("parseComboProductores", () => {
  /** Recorte del `<select>` real de la pagina del cotizador. */
  const PAGINA = `
    <div class="form-group">
      <select class="form-control" data-val="true" id="idProductor" name="Comercial.id_Productor">
        <option value="">Seleccione...</option>
        <option value="11026">BALLESTEROS, JOSE LUIS</option>
        <option value="6856" selected="selected">ARDAMA 2020 S.A.</option>
        <option value="9767">XANGO AUTOS, CONCESIONARIA</option>
      </select>
    </div>
    <select id="idConfiguracion" name="Comercial.id_Configuracion"></select>
  `;

  it("saca todos los productores del combo, no solo el seleccionado", () => {
    expect(parseComboProductores(PAGINA)).toEqual([
      { value: "11026", text: "BALLESTEROS, JOSE LUIS" },
      { value: "6856", text: "ARDAMA 2020 S.A." },
      { value: "9767", text: "XANGO AUTOS, CONCESIONARIA" },
    ]);
  });

  it("descarta el 'Seleccione...' (no tiene id numerico)", () => {
    expect(parseComboProductores(PAGINA).some((p) => p.text.startsWith("Seleccione"))).toBe(false);
  });

  it("sin combo devuelve vacio en vez de fallar: hay cuentas que lo llenan por busqueda incremental", () => {
    expect(parseComboProductores('<select id="idProductor" name="Comercial.id_Productor"></select>')).toEqual([]);
    expect(parseComboProductores("<html><body>pagina de login</body></html>")).toEqual([]);
  });
});

describe("consultasDeProductor", () => {
  it("prueba primero el nombre entero y despues palabra por palabra, de la mas larga a la mas corta", () => {
    expect(consultasDeProductor("XANGO AUTOS")).toEqual(["XANGO AUTOS", "XANGO", "AUTOS"]);
  });

  it("saca la forma societaria: buscar 'S.A.' en ABSA no discrimina nada", () => {
    expect(consultasDeProductor("ARDAMA 2020 S.A.")).toEqual(["ARDAMA 2020", "ARDAMA", "2020"]);
  });

  it("descarta las consultas de menos de 3 caracteres (ABSA no busca con eso)", () => {
    expect(consultasDeProductor("AB Motors")).not.toContain("AB");
  });

  it("no gasta mas de las consultas pedidas", () => {
    expect(consultasDeProductor("PRIMERA SEGUNDA TERCERA CUARTA", 2)).toHaveLength(2);
  });
});

describe("resolverProductor (mapeo del formulario)", () => {
  it("sin productor en el lead se usa el 'defecto' del mapeo", () => {
    expect(resolverProductor(undefined)?.clave).toBe("ardama");
  });

  it("resuelve el valor del formulario a un id de ABSA", () => {
    expect(resolverProductor("xango")?.idProductor).toBe(9767);
  });

  it("no se pelea con mayusculas, acentos ni espacios de mas", () => {
    expect(resolverProductor("  XANGO ")?.idProductor).toBe(9767);
  });

  it("acepta alias y la razon social de ABSA", () => {
    expect(resolverProductor("ardama 2020")?.idProductor).toBe(1);
    expect(resolverProductor("ARDAMA 2020 S.A.")?.idProductor).toBe(1);
  });

  it("un valor no mapeado no frena el lead: cae al 'defecto' (decision de negocio, queda el warning en el log)", () => {
    expect(resolverProductor("Concesionaria Nueva SA")?.clave).toBe("ardama");
  });

  it("no matchea por parecido: 'xango motors' no es 'xango' y cae al defecto, no al de al lado", () => {
    expect(resolverProductor("xango motors")?.clave).toBe("ardama");
  });

  it("buscarProductorMapeado exige el match exacto y NO cae al defecto (es lo que usa --mapear)", () => {
    expect(buscarProductorMapeado("xango")?.idProductor).toBe(9767);
    expect(buscarProductorMapeado("xango motors")).toBeUndefined();
    expect(buscarProductorMapeado("Concesionaria Nueva SA")).toBeUndefined();
  });
});
