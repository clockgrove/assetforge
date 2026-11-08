---
version: "1"
world: Your world
preset: flat-cartoon-kids
axes:
  rendering: flat-cartoon
  realism: clearly stylised, original fictional forms
  proportions: readable silhouettes with expressive heads
  outline:
    weight: bold
    colour: "{outline}"
  shading: flat
  detailDensity: low
  texture: clean solid colour regions, no surface grain
  lightingKey: even bright illumination
tone:
  audience: young-kids
  moodRange:
    - cheerful
    - calm
    - curious
  contentLimits:
    - no graphic violence
    - no sexual content
    - no hateful imagery
anchors:
  positive: []
  negative: []
colorRule: full
tokens:
  palette:
    ink:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.1607843137254902
          - 0.1411764705882353
          - 0.2
    warm:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.7686274509803922
          - 0.6078431372549019
          - 0.4392156862745098
    cool:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.48627450980392156
          - 0.5764705882352941
          - 0.6588235294117647
  light:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 1
        - 0.9411764705882353
        - 0.8392156862745098
  rim:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 0.6509803921568628
        - 0.7686274509803922
        - 0.9098039215686274
  fog:
    colour:
      $type: color
      $value:
        colorSpace: srgb
        components:
          - 0.6313725490196078
          - 0.6666666666666666
          - 0.7411764705882353
    density:
      $type: number
      $value: 0.1
  valueRange:
    min:
      $type: number
      $value: 0.1
    max:
      $type: number
      $value: 0.95
  saturation:
    min:
      $type: number
      $value: 0.2
    max:
      $type: number
      $value: 0.8
  outline:
    $type: color
    $value:
      colorSpace: srgb
      components:
        - 0.1607843137254902
        - 0.1411764705882353
        - 0.2
adjustable:
  mood:
    - cheerful
    - calm
    - curious
identities: {}
---

# flat-cartoon-kids

A starting art constitution; replace world, anchors and identity locks with your own original work.

## Do's and Don'ts

Do use descriptive visual language and the positive anchors. Don't copy negative anchors or violate content limits.
