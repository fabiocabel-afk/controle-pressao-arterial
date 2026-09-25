# Pressão — PWA de registro de pressão arterial

Versão 1.0.0. Lê o visor do Omron HEM-7122 pela câmera, confirma com você e guarda as leituras no próprio celular.

## Publicar

Copie o conteúdo da pasta `app/` para qualquer hospedagem com **HTTPS** (GitHub Pages, Netlify, servidor próprio). O navegador só libera a câmera em HTTPS ou em `localhost`. Depois abra o endereço no celular e use "Adicionar à tela inicial".

## Como funciona

- `engine.js`: motor de leitura (JS puro, sem bibliotecas). Localiza o visor, corrige a perspectiva, encaixa o gabarito do HEM-7122 e decodifica os segmentos.
- `worker.js`: roda o motor fora da tela, quadro a quadro. Depois de achar o visor, só rastreia (cerca de 30 a 80 ms por quadro). A leitura é aceita quando 3 quadros concordam (5 se houver reflexo).
- `app.js`: telas, câmera, conferência, histórico, gráfico, backup.
- `sw.js`: funcionamento offline.

Os dados ficam no IndexedDB do navegador. Cada gravação é relida para confirmar; se falhar, o app avisa e mantém os valores na tela. Use **Exportar backup (JSON)** no menu com regularidade: limpar os dados do navegador apaga as leituras.

## Ao alterar o app

Troque a versão em **dois lugares**, sempre juntos: `APP_VERSION` em `app/app.js` e `CACHE` em `app/sw.js` (`pressao-vX.Y.Z`). O teste de navegador confere se batem.

## Testes

Precisa de Node 18+, ffmpeg e Chrome/Chromium.

```
cd testes
npm install
npm run tudo          # motor + vídeo simulado + navegador
```

Se o Chrome estiver em outro caminho: `CHROME_PATH=/caminho/do/chrome npm run navegador`.

- `motor-fotos.js`: suas fotos reais (10) + uma imagem sem visor, que não pode gerar leitura.
- `video-fotos.js`: modo ao vivo com tremor simulado sobre as fotos reais.
- `motor-sintetico.js` / `video-sintetico.js`: visores artificiais com todos os dígitos, rotação, perspectiva e reflexo.
- `navegador.js`: 31 verificações no Chrome com câmera falsa (leitura, salvar, recarregar, digitar, validar, editar, excluir, exportar, importar, foto com reflexo, foto sem visor, offline).
