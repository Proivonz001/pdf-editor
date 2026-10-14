# Builds fixtures/word-winansi.pdf with Microsoft Word (COM automation).
# Word writes Latin text as simple TrueType fonts (WinAnsiEncoding, subset).
param([string]$Out = (Join-Path $PSScriptRoot "..\word-winansi.pdf"))
$Out = [System.IO.Path]::GetFullPath($Out)
$ErrorActionPreference = "Stop"
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection
  function Para([string]$Txt, [string]$FontName, [single]$Size, [int]$StyleId, [int]$Bold, [int]$Color) {
    $sel.Style = $doc.Styles.Item($StyleId)
    $sel.Font.Name = $FontName
    $sel.Font.Size = $Size
    $sel.Font.Bold = $Bold
    $sel.Font.Color = $Color
    # PowerShell treats curly quotes as string delimiters: use placeholders.
    $Txt = $Txt.Replace("{L}", [string][char]0x201C).Replace("{R}", [string][char]0x201D).Replace("{A}", [string][char]0x2019)
    $sel.TypeText($Txt)
    $sel.TypeParagraph()
  }
  # Built-in style names are localised; use the language-independent indices.
  $normal = -1; $h1 = -2; $h2 = -3
  Para "Relazione tecnica 2026" "Calibri" 18 $h1 1 0
  Para "Il prezzo concordato è di 1.250 € – l{A}offerta {L}speciale{R} è valida perché già approvata." "Calibri" 12 $normal 0 0
  Para "Gentile cliente, la consegna avverrà entro venerdì; più dettagli nell{A}allegato." "Cambria" 12 $normal 0 0
  Para "Capitolo secondo" "Calibri" 14 $h2 1 0
  # 0x2B39C0 is BGR for #C0392B (red)
  Para "Importante: città, perciò, così. Totale 99,90 €" "Calibri" 12 $normal 0 0x2B39C0
  # wdExportFormatPDF=17, OptimizeFor print=0, Range all=0, Item content=0,
  # IncludeDocProps, KeepIRM, CreateBookmarks=1 (headings)
  $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 0, 0, 0, $true, $true, 1)
  $doc.Close(0)
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
Write-Output "wrote $Out"
